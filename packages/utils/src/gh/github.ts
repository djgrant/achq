// GitHub's REST API as what callers mean: each route and its response type is
// written once here, so call sites read as intent (`repo.headOf(branch)`), not
// as URLs. Which token a call needs is the caller's business: App JWT for the
// App's own routes, installation or user token for the rest.
import { type Auth, type ClientOptions, GitHubClient, GitHubError } from "./client.ts";
import type {
  AccessToken,
  AppInfo,
  CommitSummary,
  CreatedApp,
  GitBlob,
  GitCommit,
  GitRef,
  GitTree,
  HookConfig,
  Installation,
  Issue,
  IssueComment,
  ReactionContent,
  ReactionTarget,
  RepoInfo,
  RepoName,
  TokenNarrowing,
  TreeEntry,
  User,
  UserInstallation,
  Variable,
} from "./types.ts";

const enc = encodeURIComponent;

export class GitHub {
  constructor(readonly client: GitHubClient) {}

  /** A GitHub over a new client. */
  static connect(auth: Auth, options: ClientOptions = {}) {
    return new GitHub(new GitHubClient(auth, options));
  }

  get baseUrl() {
    return this.client.baseUrl;
  }

  repo(fullName: string) {
    return new RepoApi(this.client, fullName);
  }

  // ── As the App (JWT) ──

  app() {
    return this.client.request<AppInfo>("GET", "/app");
  }

  hookConfig() {
    return this.client.request<HookConfig>("GET", "/app/hook/config");
  }

  async setHookConfig(config: HookConfig) {
    await this.client.request("PATCH", "/app/hook/config", config);
  }

  installations() {
    return this.client.paginate<Installation>("/app/installations");
  }

  createInstallationToken(installationId: number, narrow: TokenNarrowing = {}) {
    return this.client.request<AccessToken>("POST", `/app/installations/${installationId}/access_tokens`, narrow);
  }

  // ── Anyone ──

  /** An App's public settings, or undefined if it's private (GitHub 404s it, even to its owner). */
  publicApp(slug: string) {
    return this.client.find<AppInfo>("GET", `/apps/${enc(slug)}`);
  }

  /** Trades the manifest flow's one-time code for the App it created. Needs no auth. */
  convertManifest(code: string) {
    return this.client.request<CreatedApp>("POST", `/app-manifests/${enc(code)}/conversions`);
  }

  user(login: string) {
    return this.client.request<User>("GET", `/users/${enc(login)}`);
  }

  // ── As an installation ──

  installationRepos() {
    return this.client.paginate<RepoName>("/installation/repositories", (page) => page.repositories);
  }

  // ── As a user ──

  userInstallations() {
    return this.client.paginate<UserInstallation>("/user/installations", (page) => page.installations);
  }

  userInstallationRepos(installationId: number) {
    return this.client.paginate<RepoName>(`/user/installations/${installationId}/repositories`, (page) => page.repositories);
  }

  /** Adds a repo to a selected-repos installation. The same route serves user and org installations; it needs admin on the repo. */
  async addToInstallation(installationId: number, repoId: number) {
    await this.client.request("PUT", `/user/installations/${installationId}/repositories/${repoId}`);
  }

  async removeFromInstallation(installationId: number, repoId: number) {
    await this.client.request("DELETE", `/user/installations/${installationId}/repositories/${repoId}`);
  }
}

/** One repo's routes. */
export class RepoApi {
  private route: string;

  constructor(
    private client: GitHubClient,
    readonly fullName: string,
  ) {
    this.route = `/repos/${fullName}`;
  }

  // ── The repo ──

  info() {
    return this.client.request<RepoInfo>("GET", this.route);
  }

  /** Whether the token can push. Any refusal (a bad token, no access) means no. */
  async canPush() {
    const res = await this.client.raw("GET", this.route);
    if (!res.ok) return false;
    const { permissions } = (await res.json()) as RepoInfo;
    return permissions?.push === true;
  }

  /** The latest commit on `branch` that changed `path`, if any did. */
  async latestCommitTouching(branch: string, path: string): Promise<CommitSummary | undefined> {
    const [latest] = await this.client.request<CommitSummary[]>("GET", `${this.route}/commits?sha=${enc(branch)}&per_page=1&path=${enc(path)}`);
    return latest;
  }

  /** The App's installation on the repo's owner, or undefined if there's none. It may not cover this repo: see TokenNarrowing. */
  installation() {
    return this.client.find<Installation>("GET", `${this.route}/installation`);
  }

  // ── Git data ──

  /** The SHA of the commit at the tip of `branch`. */
  async headOf(branch: string) {
    const { object } = await this.client.request<GitRef>("GET", `${this.route}/git/ref/heads/${enc(branch)}`);
    return object.sha;
  }

  /** The SHA of a commit's root tree. */
  async rootTreeOf(commitSha: string) {
    const { tree } = await this.client.request<GitCommit>("GET", `${this.route}/git/commits/${commitSha}`);
    return tree.sha;
  }

  /** A tree's direct entries. */
  async tree(treeSha: string): Promise<TreeEntry[]> {
    return (await this.client.request<GitTree>("GET", `${this.route}/git/trees/${treeSha}`)).tree;
  }

  /** Every entry under a tree, paths relative to it. Throws if GitHub cut the listing short. */
  async listTree(treeSha: string, what = `tree ${treeSha}`): Promise<TreeEntry[]> {
    const { tree, truncated } = await this.client.request<GitTree>("GET", `${this.route}/git/trees/${treeSha}?recursive=1`);
    if (truncated) throw new Error(`${what} has too many files for GitHub to list`);
    return tree;
  }

  /** The SHA of the directory at `path` (`a/b`) in a commit, or undefined if there's none. */
  async subtree(commitSha: string, path: string): Promise<string | undefined> {
    let treeSha: string | undefined = await this.rootTreeOf(commitSha);
    for (const name of path.split("/").filter(Boolean)) {
      const entries: TreeEntry[] = await this.tree(treeSha);
      treeSha = entries.find((entry) => entry.path === name && entry.type === "tree")?.sha;
      if (!treeSha) return undefined;
    }
    return treeSha;
  }

  /** A blob's bytes. */
  async blob(blobSha: string): Promise<Buffer> {
    const { content, encoding } = await this.client.request<GitBlob>("GET", `${this.route}/git/blobs/${blobSha}`);
    return Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
  }

  // ── Actions variables ──

  /** A repository variable's value, or undefined if it isn't set. */
  async variable(name: string): Promise<string | undefined> {
    return (await this.client.find<Variable>("GET", `${this.route}/actions/variables/${enc(name)}`))?.value;
  }

  /** Sets a repository variable: updates it, or creates it if it isn't there. */
  async upsertVariable(name: string, value: string) {
    const route = `${this.route}/actions/variables/${enc(name)}`;
    const updated = await this.client.raw("PATCH", route, { name, value });
    if (updated.status === 404) await this.client.request("POST", `${this.route}/actions/variables`, { name, value });
    else if (!updated.ok) throw new GitHubError(updated.status, "PATCH", route, await updated.text());
  }

  // ── Issues ──

  issue(number: number) {
    return this.client.request<Issue>("GET", `${this.route}/issues/${number}`);
  }

  issueComments(number: number) {
    return this.client.paginate<IssueComment>(`${this.route}/issues/${number}/comments`);
  }

  comment(number: number, body: string) {
    return this.client.request<IssueComment>("POST", `${this.route}/issues/${number}/comments`, { body });
  }

  async react(target: ReactionTarget, content: ReactionContent) {
    const on = "comment" in target ? `comments/${target.comment}` : String(target.issue);
    await this.client.request("POST", `${this.route}/issues/${on}/reactions`, { content });
  }
}

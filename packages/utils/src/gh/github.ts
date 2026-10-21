import { createAppAuth } from "@octokit/auth-app";
import { Octokit as Core } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods, type RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { RequestError } from "@octokit/request-error";
import type { Vars } from "../env.ts";
import { subprocess } from "../subprocess.ts";
import type { AppSettings, HookConfig, Installation, Permissions, ReactionContent, ReactionTarget, TokenNarrowing, UserInstallation } from "./types.ts";

/** Without a request log: a 404 is often an answer, not an error to print. */
const Octokit = Core.plugin(restEndpointMethods, paginateRest);
type Octokit = InstanceType<typeof Octokit>;

const USER_AGENT = "achq";

/** GitHub's largest page: fewer requests for long lists. */
const PAGE_SIZE = 100;

/** `baseUrl` points the client at a fake. */
export type Connection = { token?: string; baseUrl?: string };

type RawInstallation = RestEndpointMethodTypes["apps"]["getRepoInstallation"]["response"]["data"];
/** GitHub's schema lists fewer permissions than a token can ask for, e.g. not `actions_variables`. */
type TokenPermissions = RestEndpointMethodTypes["apps"]["createInstallationAccessToken"]["parameters"]["permissions"];

const installationOf = (raw: RawInstallation): UserInstallation => ({
  id: raw.id,
  app_slug: raw.app_slug,
  account: raw.account && "login" in raw.account ? { login: raw.account.login, type: raw.account.type } : { login: "", type: "Enterprise" },
  permissions: raw.permissions as Permissions,
  repository_selection: raw.repository_selection,
  suspended_at: raw.suspended_at,
});

/** GitHub's schema allows an App to be null where there's always one. */
const settingsOf = (app: { events: string[]; permissions: object } | null): AppSettings => ({ events: app?.events ?? [], permissions: (app?.permissions ?? {}) as Permissions });

/** The answer, or undefined when GitHub says there's no such thing. */
const unlessMissing = async <T>(request: Promise<{ data: T }>): Promise<T | undefined> => {
  try {
    return (await request).data;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return undefined;
    throw error;
  }
};

export class GitHub {
  constructor(readonly octokit: Octokit) {}

  /** With an installation's or a user's token, or without one, for what anyone can see. */
  static connect({ token, baseUrl }: Connection = {}) {
    return new GitHub(new Octokit({ auth: token, baseUrl, userAgent: USER_AGENT }));
  }

  /** As the App itself: each request carries a JWT its private key signs. */
  static connectAsApp(appId: string, privateKey: string, { baseUrl }: Pick<Connection, "baseUrl"> = {}) {
    return new GitHub(new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey }, baseUrl, userAgent: USER_AGENT }));
  }

  /** Your gh login's token: `GH_TOKEN` in `env` wins, as it does for gh itself; otherwise `gh auth token`. */
  static cliToken(env: Vars = {}): string {
    if (env.GH_TOKEN) return env.GH_TOKEN;
    const { ok, stdout, stderr } = subprocess.run(["gh", "auth", "token"]);
    if (!ok) throw new Error(`Needs a gh login (gh auth login): ${stderr.trim()}`);
    return stdout.trim();
  }

  /** Logins compare case-insensitively, as GitHub compares them. */
  static sameLogin(a: string, b: string) {
    return a.toLowerCase() === b.toLowerCase();
  }

  repo(fullName: string) {
    return new RepoApi(this.octokit, fullName);
  }

  // ── As the App ──

  async app() {
    return settingsOf((await this.octokit.rest.apps.getAuthenticated()).data);
  }

  async hookConfig() {
    return (await this.octokit.rest.apps.getWebhookConfigForApp()).data;
  }

  async setHookConfig(config: HookConfig) {
    // As a parameter, the config's `url` would be taken for the request's own.
    await this.octokit.request("PATCH /app/hook/config", { data: config });
  }

  async installations(): Promise<Installation[]> {
    return (await this.octokit.paginate(this.octokit.rest.apps.listInstallations, { per_page: PAGE_SIZE })).map(installationOf);
  }

  async createInstallationToken(installationId: number, { repositories, permissions }: TokenNarrowing = {}) {
    return (await this.octokit.rest.apps.createInstallationAccessToken({ installation_id: installationId, repositories, permissions: permissions as TokenPermissions })).data;
  }

  // ── Anyone ──

  /** An App's public settings, or undefined if it's private (GitHub 404s it, even to its owner). */
  async publicApp(slug: string) {
    const app = await unlessMissing(this.octokit.rest.apps.getBySlug({ app_slug: slug }));
    return app ? settingsOf(app) : undefined;
  }

  /** Trades the manifest flow's one-time code for the App it created. Needs no auth. */
  async convertManifest(code: string) {
    return (await this.octokit.rest.apps.createFromManifest({ code })).data;
  }

  async user(login: string) {
    return (await this.octokit.rest.users.getByUsername({ username: login })).data;
  }

  // ── As an installation ──

  installationRepos() {
    return this.octokit.paginate(this.octokit.rest.apps.listReposAccessibleToInstallation, { per_page: PAGE_SIZE });
  }

  // ── As a user ──

  async userInstallations(): Promise<UserInstallation[]> {
    return (await this.octokit.paginate(this.octokit.rest.apps.listInstallationsForAuthenticatedUser, { per_page: PAGE_SIZE })).map(installationOf);
  }

  userInstallationRepos(installationId: number) {
    return this.octokit.paginate(this.octokit.rest.apps.listInstallationReposForAuthenticatedUser, { installation_id: installationId, per_page: PAGE_SIZE });
  }

  /** Adds a repo to a selected-repos installation. The same route serves user and org installations; it needs admin on the repo. */
  async addToInstallation(installationId: number, repoId: number) {
    await this.octokit.rest.apps.addRepoToInstallationForAuthenticatedUser({ installation_id: installationId, repository_id: repoId });
  }

  async removeFromInstallation(installationId: number, repoId: number) {
    await this.octokit.rest.apps.removeRepoFromInstallationForAuthenticatedUser({ installation_id: installationId, repository_id: repoId });
  }
}

export class RepoApi {
  private at: { owner: string; repo: string };

  constructor(
    private octokit: Octokit,
    readonly fullName: string,
  ) {
    const [owner = "", repo = ""] = fullName.split("/");
    this.at = { owner, repo };
  }

  async info() {
    return (await this.octokit.rest.repos.get(this.at)).data;
  }

  /** Whether the token can push. Any refusal (a bad token, no access) means no. */
  async canPush() {
    try {
      return (await this.info()).permissions?.push === true;
    } catch (error) {
      if (error instanceof RequestError) return false;
      throw error;
    }
  }

  async latestCommitTouching(branch: string, path: string) {
    const [latest] = (await this.octokit.rest.repos.listCommits({ ...this.at, sha: branch, path, per_page: 1 })).data;
    return latest;
  }

  /** The App's installation on the repo's owner, or undefined if there's none. It may not cover this repo: see TokenNarrowing. */
  async installation(): Promise<Installation | undefined> {
    const found = await unlessMissing(this.octokit.rest.apps.getRepoInstallation(this.at));
    return found && installationOf(found);
  }

  async headOf(branch: string) {
    return (await this.octokit.rest.git.getRef({ ...this.at, ref: `heads/${branch}` })).data.object.sha;
  }

  async rootTreeOf(commitSha: string) {
    return (await this.octokit.rest.git.getCommit({ ...this.at, commit_sha: commitSha })).data.tree.sha;
  }

  /** A tree's direct entries. */
  async tree(treeSha: string) {
    return (await this.octokit.rest.git.getTree({ ...this.at, tree_sha: treeSha })).data.tree;
  }

  /** Every entry under a tree, paths relative to it. Throws if GitHub cut the listing short. */
  async listTree(treeSha: string, what = `tree ${treeSha}`) {
    const { tree, truncated } = (await this.octokit.rest.git.getTree({ ...this.at, tree_sha: treeSha, recursive: "1" })).data;
    if (truncated) throw new Error(`${what} has too many files for GitHub to list`);
    return tree;
  }

  /** The SHA of the directory at `path` (`a/b`) in a commit, or undefined if there's none. */
  async subtree(commitSha: string, path: string): Promise<string | undefined> {
    let treeSha: string | undefined = await this.rootTreeOf(commitSha);
    for (const name of path.split("/").filter(Boolean)) {
      const entries = await this.tree(treeSha);
      treeSha = entries.find((entry) => entry.path === name && entry.type === "tree")?.sha;
      if (!treeSha) return undefined;
    }
    return treeSha;
  }

  async blob(blobSha: string) {
    const { content, encoding } = (await this.octokit.rest.git.getBlob({ ...this.at, file_sha: blobSha })).data;
    return Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
  }

  async variable(name: string) {
    return (await unlessMissing(this.octokit.rest.actions.getRepoVariable({ ...this.at, name })))?.value;
  }

  async upsertVariable(name: string, value: string) {
    try {
      await this.octokit.rest.actions.updateRepoVariable({ ...this.at, name, value });
    } catch (error) {
      if (!(error instanceof RequestError && error.status === 404)) throw error;
      await this.octokit.rest.actions.createRepoVariable({ ...this.at, name, value });
    }
  }

  async issue(number: number) {
    return (await this.octokit.rest.issues.get({ ...this.at, issue_number: number })).data;
  }

  issueComments(number: number) {
    return this.octokit.paginate(this.octokit.rest.issues.listComments, { ...this.at, issue_number: number, per_page: PAGE_SIZE });
  }

  async comment(number: number, body: string) {
    return (await this.octokit.rest.issues.createComment({ ...this.at, issue_number: number, body })).data;
  }

  async react(target: ReactionTarget, content: ReactionContent) {
    if ("comment" in target) await this.octokit.rest.reactions.createForIssueComment({ ...this.at, comment_id: target.comment, content });
    else await this.octokit.rest.reactions.createForIssue({ ...this.at, issue_number: target.issue, content });
  }
}

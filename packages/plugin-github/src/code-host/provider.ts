import { type CodeHostProvider, type ConfigTree, type Credential, type FileLimits, type InstallationRequest, type RepoClient, type RepoInstallation, type RepoManifest, repoName, STATUS_VARIABLE, type Status } from "@achq/core";
import type { Vars } from "@achq/utils/env";
import { http } from "@achq/utils/http";
import { type CommitSummary, GitHub, type RepoApi } from "@achq/utils/gh";
import { text } from "@achq/utils/text";
import type { Apps } from "../lib/apps.ts";
import { configNeeds, configSource } from "../lib/config-needs.ts";
import { CODE_HOST, githubUrls, type GitHubUrls, POLICY_PROVIDER, REPO_NAME } from "../lib/constants.ts";
import { DEPLOYER_PERMISSIONS } from "../lib/permissions.ts";
import { asYou } from "../lib/you.ts";
import type { GitHubPolicyData } from "../policy/resource.ts";
import { CodeHost } from "./resource.ts";

const CONFIG_DIR = ".achq";
/** A git tree entry's mode for a symlink, whose blob is only the path it points to. */
const SYMLINK_MODE = "120000";
const LIST_PERMISSIONS = { metadata: "read" };
const STATUS_EXCERPT_CHARS = 200;
const NOT_FOUND = 404;

/** A repo is set up for achq when the config's one App is installed on it. Only the router has the App keys that list where. */
export class GitHubCodeHostProvider implements CodeHostProvider {
  readonly repoName = REPO_NAME;
  private urls: GitHubUrls;
  private you?: GitHub;

  constructor(
    private env: Vars,
    private apps: Apps,
  ) {
    this.urls = githubUrls(env);
  }

  /** You, through your gh login: the CLI's side. Logged in on first use, since the router makes this provider too. */
  private get gh() {
    return (this.you ??= asYou(this.env));
  }

  /** Through whichever App is installed on the repo: GitHub's policy provider finds it. */
  deployerPolicy(repo: string): GitHubPolicyData {
    return { provider: POLICY_PROVIDER, repo, permissions: { ...DEPLOYER_PERMISSIONS } };
  }

  repo(repo: string, credential: Credential) {
    return new GitHubRepoClient(GitHub.connect({ token: credential.value, baseUrl: this.urls.api }).repo(repo));
  }

  canPush(repo: string, token: string) {
    return GitHub.connect({ token, baseUrl: this.urls.api }).repo(repo).canPush();
  }

  cloneUrl(repo: string) {
    return `${this.urls.web}/${repo}.git`;
  }

  /** From an https or ssh remote. */
  repoOf(remote: string) {
    const host = text.escapeRegExp(new URL(this.urls.web).host);
    return remote.trim().match(new RegExp(`${host}[:/]([\\w.-]+/[\\w.-]+?)(?:\\.git)?$`))?.[1];
  }

  token() {
    return GitHub.cliToken(this.env);
  }

  async status(repo: string) {
    const value = await this.gh.repo(repo).variable(STATUS_VARIABLE);
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value) as Status;
    } catch {
      throw new Error(`${repo}'s ${STATUS_VARIABLE} isn't JSON: ${value.slice(0, STATUS_EXCERPT_CHARS)}`);
    }
  }

  async lastCommit(repo: string, branch: string, paths: string[]) {
    const api = this.gh.repo(repo);
    const latestPerPath = await Promise.all(paths.map((path) => api.latestCommitTouching(branch, path)));
    const committedAt = (commit: CommitSummary) => commit.commit.committer?.date ?? "";
    const [latest] = latestPerPath.filter((commit) => commit !== undefined).sort((a, b) => committedAt(b).localeCompare(committedAt(a)));
    if (!latest) throw new Error(`No commits on ${repo}`);
    return latest.sha;
  }

  install(repo: string, manifest: RepoManifest) {
    return [this.codeHost(repo, manifest, true)];
  }

  uninstall(repo: string, manifest: RepoManifest) {
    return [this.codeHost(repo, manifest, false)];
  }

  private codeHost(repo: string, manifest: RepoManifest, installed: boolean) {
    const slug = configSource(manifest);
    return new CodeHost({ slug, repo, installed, needs: configNeeds(manifest, slug) }, (r, source) => this.askRouter(r, source, installed));
  }

  /**
   * Whether the App is installed on the repo, from the router ACHQ_STATUS
   * names, which checks you can push to it. Undefined without one, or, when
   * installing, when it's gone: the repo moved to another hq, whose deploy
   * names its own router.
   */
  private async askRouter(repo: string, slug: string, installing: boolean): Promise<RepoInstallation | undefined> {
    const router = (await this.status(repo))?.router;
    if (!router) return undefined;
    const res = await fetch(`${router}/installation`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ host: CODE_HOST, repo, source: slug } satisfies InstallationRequest),
    });
    if (res.status === NOT_FOUND) {
      if (installing) return undefined;
      throw new Error(`No router answers at ${router}, which ${repo}'s ${STATUS_VARIABLE} names: its hq may have been torn down. Bring it back with \`achq infra up\`, or remove ${slug} from its installation in ${repoName.split(repo).owner}'s settings on GitHub`);
    }
    await http.expectOk(res, `The router at ${router} couldn't say whether ${slug} is installed on ${repo}`);
    return (await res.json()) as RepoInstallation;
  }

  /** The repos every App's installations cover. Suspended installations are skipped: they can't mint tokens. */
  async installed() {
    const perApp = await Promise.all(
      this.apps.slugs().map(async (slug) => {
        const repos: string[] = [];
        for (const installation of await this.apps.asApp(slug).installations()) {
          if (installation.suspended_at) continue;
          const { token } = await this.apps.token(slug, installation.id, { permissions: LIST_PERMISSIONS });
          for (const { full_name } of await GitHub.connect({ token, baseUrl: this.apps.baseUrl }).installationRepos()) repos.push(full_name);
        }
        return repos;
      }),
    );
    // Each repo once, compared as GitHub does; the last spelling wins.
    const repos = new Map(perApp.flat().map((repo) => [repoName.key(repo), repo]));
    return [...repos.values()].map((repo) => ({ host: CODE_HOST, repo }));
  }

  /** As the App: its installation on the repo's owner, if any, and whether it reaches the repo. A suspended one doesn't. */
  async installation(repo: string, slug: string): Promise<RepoInstallation | undefined> {
    if (!this.apps.has(slug)) return undefined;
    const { web } = this.urls;
    const { owner } = repoName.split(repo);
    const found = (await this.apps.asApp(slug).installations()).find((i) => GitHub.sameLogin(i.account.login, owner));
    if (!found) return { installed: false, url: `${web}/apps/${slug}/installations/new` };
    const { id, account } = found;
    // Where you choose its repos.
    const url = account.type === "Organization" ? `${web}/organizations/${account.login}/settings/installations/${id}` : `${web}/settings/installations/${id}`;
    return { installed: !found.suspended_at && (await this.apps.covers(slug, id, repo)).covered, url };
  }
}

/** The repo as the deployer's token reaches it. */
class GitHubRepoClient implements RepoClient {
  constructor(private repo: RepoApi) {}

  async config(): Promise<ConfigTree> {
    const { default_branch: branch } = await this.repo.info();
    const commit = await this.repo.headOf(branch);
    const configSha = await this.repo.subtree(commit, CONFIG_DIR);
    if (!configSha) return { commit, branch, blobs: new Map() };
    const entries = await this.repo.listTree(configSha, `${CONFIG_DIR}/`);
    // Only files with content: symlinks and submodules (`commit`) aren't followed.
    const files = entries.filter((entry) => entry.type === "blob" && entry.mode !== SYMLINK_MODE);
    return { commit, branch, tree: configSha, blobs: new Map(files.map((entry) => [entry.path, { sha: entry.sha, size: entry.size ?? 0 }])) };
  }

  async download(tree: ConfigTree, paths: string[], limits: FileLimits) {
    if (paths.length > limits.maxFiles) throw new Error(`${CONFIG_DIR}/ has ${paths.length} source files; the limit is ${limits.maxFiles}`);
    const listed = paths.reduce((sum, path) => sum + (tree.blobs.get(path)?.size ?? 0), 0);
    if (listed > limits.maxBytes) throw new Error(`${CONFIG_DIR}/'s source files total ${listed} bytes; the limit is ${limits.maxBytes}`);
    const files: Record<string, string> = {};
    let downloaded = 0;
    for (const path of paths) {
      const blob = tree.blobs.get(path);
      if (!blob) throw new Error(`${CONFIG_DIR}/${path} isn't in the tree`);
      const bytes = await this.repo.blob(blob.sha);
      // Sizes come from the listing; check what actually arrived too.
      downloaded += bytes.length;
      if (downloaded > limits.maxBytes) throw new Error(`${CONFIG_DIR}/'s source files are over the ${limits.maxBytes}-byte limit`);
      files[path] = bytes.toString("utf8");
    }
    return files;
  }

  writeStatus(status: Status) {
    return this.repo.upsertVariable(STATUS_VARIABLE, JSON.stringify(status));
  }

  clearStatus() {
    return this.repo.deleteVariable(STATUS_VARIABLE);
  }
}

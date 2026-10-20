// The deployer reads `.achq/` and writes ACHQ_STATUS with the repo-scoped token
// the router minted for it. The router checks `/wake` with the caller's token,
// and lists installed repos with the App keys. The CLI reads ACHQ_STATUS,
// commits, and installs the config's App as your gh login.
import { type CodeHostProvider, type ConfigTree, type Credential, type FileLimits, type InstalledRepo, type RepoClient, type RepoManifest, STATUS_VARIABLE, type Status } from "@achq/core";
import { type GitHub, ghToken, repoKey, type RepoApi, type TreeEntry } from "@achq/utils/gh";
import type { Apps } from "../lib/apps.ts";
import { asToken, github, type GitHubUrls } from "../lib/client.ts";
import { configNeeds, configSource } from "../lib/config-needs.ts";
import { CODE_HOST, POLICY_PROVIDER, REPO_NAME } from "../lib/constants.ts";
import { DEPLOYER_PERMISSIONS } from "../lib/permissions.ts";
import { lastCommit, readStatus, repoOf } from "../lib/repos.ts";
import { userGitHub } from "../lib/user.ts";
import type { GitHubPolicyData } from "../policy/resource.ts";
import { CodeHost } from "./resource.ts";

/** The repo's config directory. */
const CONFIG_DIR = ".achq";
/** A git tree entry's mode for a symlink, whose blob is only the path it points to. */
const SYMLINK_MODE = "120000";
/** What listing an installation's repos needs. */
const LIST_PERMISSIONS = { metadata: "read" };

/** A file with content: not a directory, a submodule (`commit`) or a symlink. */
const isRegularFile = (entry: TreeEntry) => entry.type === "blob" && entry.mode !== SYMLINK_MODE;

/** The config's files, by path under `.achq/`. Symlinks and submodules aren't followed. */
const configBlobs = (entries: TreeEntry[]): ConfigTree["blobs"] =>
  new Map(entries.filter(isRegularFile).map((entry) => [entry.path, { sha: entry.sha, size: entry.size ?? 0 }]));

/** Refuses a download the listing already says is too big, before fetching any of it. */
const assertWithinLimits = (paths: string[], tree: ConfigTree, limits: FileLimits) => {
  if (paths.length > limits.maxFiles) throw new Error(`${CONFIG_DIR}/ has ${paths.length} source files; the limit is ${limits.maxFiles}`);
  const listed = paths.reduce((sum, path) => sum + (tree.blobs.get(path)?.size ?? 0), 0);
  if (listed > limits.maxBytes) throw new Error(`${CONFIG_DIR}/'s source files total ${listed} bytes; the limit is ${limits.maxBytes}`);
};

/** The repo as the deployer's token reaches it. */
const repoClient = (repo: RepoApi): RepoClient => ({
  async config(): Promise<ConfigTree> {
    const { default_branch: branch } = await repo.info();
    const commit = await repo.headOf(branch);
    const configSha = await repo.subtree(commit, CONFIG_DIR);
    if (!configSha) return { commit, branch, blobs: new Map() };
    const entries = await repo.listTree(configSha, `${CONFIG_DIR}/`);
    return { commit, branch, tree: configSha, blobs: configBlobs(entries) };
  },

  async download(tree: ConfigTree, paths: string[], limits: FileLimits) {
    assertWithinLimits(paths, tree, limits);
    const files: Record<string, string> = {};
    let downloaded = 0;
    for (const path of paths) {
      const blob = tree.blobs.get(path);
      if (!blob) throw new Error(`${CONFIG_DIR}/${path} isn't in the tree`);
      const bytes = await repo.blob(blob.sha);
      // Sizes come from the listing; check what actually arrived too.
      downloaded += bytes.length;
      if (downloaded > limits.maxBytes) throw new Error(`${CONFIG_DIR}/'s source files are over the ${limits.maxBytes}-byte limit`);
      files[path] = bytes.toString("utf8");
    }
    return files;
  },

  /** ACHQ_STATUS is a repository variable. */
  writeStatus(status: Status) {
    return repo.upsertVariable(STATUS_VARIABLE, JSON.stringify(status));
  },
});

/** Repos on GitHub. A repo is set up for achq when the config's one App is installed on it. Only the router has the App keys that list where. */
export class GitHubCodeHostProvider implements CodeHostProvider {
  readonly repoName = REPO_NAME;
  /** You, through your gh login: the CLI's side. */
  private gh: GitHub;

  constructor(
    private urls: GitHubUrls,
    private apps: Apps,
  ) {
    this.gh = userGitHub(urls.api);
  }

  /** Through whichever App is installed on the repo: GitHub's policy provider finds it. */
  deployerPolicy(repo: string): GitHubPolicyData {
    return { provider: POLICY_PROVIDER, repo, permissions: { ...DEPLOYER_PERMISSIONS } };
  }

  repo(repo: string, credential: Credential) {
    return repoClient(asToken(credential.value, this.urls.api).repo(repo));
  }

  canPush(repo: string, token: string) {
    return github(`Bearer ${token}`, this.urls.api).repo(repo).canPush();
  }

  cloneUrl(repo: string) {
    return `${this.urls.web}/${repo}.git`;
  }

  repoOf(remote: string) {
    return repoOf(remote, this.urls.web);
  }

  token() {
    return ghToken();
  }

  status(repo: string) {
    return readStatus(this.gh, repo);
  }

  lastCommit(repo: string, branch: string, paths: string[]) {
    return lastCommit(this.gh, repo, branch, paths);
  }

  install(repo: string, manifest: RepoManifest) {
    return [this.codeHost(repo, manifest, true)];
  }

  uninstall(repo: string, manifest: RepoManifest) {
    return [this.codeHost(repo, manifest, false)];
  }

  private codeHost(repo: string, manifest: RepoManifest, installed: boolean) {
    const slug = configSource(manifest);
    return new CodeHost({ slug, repo, installed, needs: configNeeds(manifest, slug) });
  }

  /** Every repo an App is installed on, once. */
  async installed(): Promise<InstalledRepo[]> {
    const perApp = await Promise.all(this.apps.slugs().map((slug) => this.appInstalledRepos(slug)));
    return dedupe(perApp.flat()).map((repo) => ({ host: CODE_HOST, repo }));
  }

  /** The repos an App's installations cover, skipping suspended ones (they can't mint tokens). */
  private async appInstalledRepos(slug: string): Promise<string[]> {
    const repos: string[] = [];
    for (const installation of await this.apps.asApp(slug).installations()) {
      if (installation.suspended_at) continue;
      const { token } = await this.apps.token(slug, installation.id, { permissions: LIST_PERMISSIONS });
      for (const { full_name } of await asToken(token, this.apps.baseUrl).installationRepos()) repos.push(full_name);
    }
    return repos;
  }
}

/** Each repo once, compared as GitHub does; the last spelling wins. */
const dedupe = (repos: string[]) => [...new Map(repos.map((repo) => [repoKey(repo), repo])).values()];

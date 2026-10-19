// The deployer reads `.achq/` and writes ACHQ_STATUS with the repo-scoped token
// the router minted for it. The router checks `/wake` with the caller's token.
// The CLI reads ACHQ_STATUS and commits as your gh login.
import { type ConfigTree, type Credential, type FileLimits, type RepoClient, type CodeHost, STATUS_VARIABLE, type Status } from "@achq/core";
import { GitHubClient, type GitHubUrls } from "../lib/client.ts";
import { POLICY_PROVIDER, REPO_NAME } from "../lib/constants.ts";
import { DEPLOYER_PERMISSIONS } from "../lib/permissions.ts";
import { lastCommit, readStatus, repoOf } from "../lib/repos.ts";
import { ghToken, userGitHub } from "../lib/user.ts";
import type { GitHubPolicyData } from "../policy/resource.ts";

type TreeEntry = { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number };

const repoClient = (repo: string, token: string, baseUrl: string): RepoClient => {
  const gh = new GitHubClient(`token ${token}`, baseUrl);
  const route = `/repos/${repo}`;

  return {
    async config(): Promise<ConfigTree> {
      const { default_branch: branch } = await gh.request<{ default_branch: string }>("GET", route);
      const ref = await gh.request<{ object: { sha: string } }>("GET", `${route}/git/ref/heads/${encodeURIComponent(branch)}`);
      const commit = ref.object.sha;
      const { tree: root } = await gh.request<{ tree: { sha: string } }>("GET", `${route}/git/commits/${commit}`);
      const top = await gh.request<{ tree: TreeEntry[] }>("GET", `${route}/git/trees/${root.sha}`);
      const achq = top.tree.find((e) => e.path === ".achq" && e.type === "tree");
      const blobs = new Map<string, { sha: string; size: number }>();
      if (!achq) return { commit, branch, blobs };
      const listing = await gh.request<{ tree: TreeEntry[]; truncated?: boolean }>("GET", `${route}/git/trees/${achq.sha}?recursive=1`);
      if (listing.truncated) throw new Error(".achq/ has too many files for GitHub to list");
      // Symlinks (120000) and submodules aren't followed: a link's blob is only its target path.
      for (const e of listing.tree) if (e.type === "blob" && e.mode !== "120000") blobs.set(e.path, { sha: e.sha, size: e.size ?? 0 });
      return { commit, branch, tree: achq.sha, blobs };
    },

    async download(tree: ConfigTree, paths: string[], limits: FileLimits) {
      if (paths.length > limits.maxFiles) throw new Error(`.achq/ has ${paths.length} source files; the limit is ${limits.maxFiles}`);
      const total = paths.reduce((sum, p) => sum + (tree.blobs.get(p)?.size ?? 0), 0);
      if (total > limits.maxBytes) throw new Error(`.achq/'s source files total ${total} bytes; the limit is ${limits.maxBytes}`);
      const files: Record<string, string> = {};
      let downloaded = 0;
      for (const path of paths) {
        const blob = tree.blobs.get(path);
        if (!blob) throw new Error(`.achq/${path} isn't in the tree`);
        const { content, encoding } = await gh.request<{ content: string; encoding: string }>("GET", `${route}/git/blobs/${blob.sha}`);
        const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
        downloaded += bytes.length;
        // Sizes come from the listing; check what actually arrived too.
        if (downloaded > limits.maxBytes) throw new Error(`.achq/'s source files are over the ${limits.maxBytes}-byte limit`);
        files[path] = bytes.toString("utf8");
      }
      return files;
    },

    /** ACHQ_STATUS is a repository variable. */
    async writeStatus(status: Status) {
      const value = JSON.stringify(status);
      const res = await gh.raw("PATCH", `${route}/actions/variables/${STATUS_VARIABLE}`, { name: STATUS_VARIABLE, value });
      if (res.status === 404) await gh.request("POST", `${route}/actions/variables`, { name: STATUS_VARIABLE, value });
      else if (!res.ok) throw new Error(`Writing ${STATUS_VARIABLE}: GitHub ${res.status} ${(await res.text()).slice(0, 300)}`);
    },
  };
};

export class GitHubCodeHost implements CodeHost {
  readonly repoName = REPO_NAME;
  /** You, through your gh login: the CLI's side. */
  private gh: GitHubClient;

  constructor(private urls: GitHubUrls) {
    this.gh = userGitHub(urls.api);
  }

  deployerPolicy(source: string, repo: string): GitHubPolicyData {
    return { provider: POLICY_PROVIDER, source, repo, permissions: { ...DEPLOYER_PERMISSIONS } };
  }

  repo(repo: string, credential: Credential) {
    return repoClient(repo, credential.value, this.urls.api);
  }

  async canPush(repo: string, token: string) {
    const res = await new GitHubClient(`Bearer ${token}`, this.urls.api).raw("GET", `/repos/${repo}`);
    if (!res.ok) return false;
    const data = (await res.json()) as { permissions?: { push?: boolean } };
    return data.permissions?.push === true;
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
}

// The deployer reads `.achq/` and writes ACHQ_STATUS with the repo-scoped token
// the router minted for it. The router checks `/wake` with the caller's token.
// The CLI reads ACHQ_STATUS and commits as your gh login.
import { type ConfigTree, type Credential, type FileLimits, type RepoClient, type RepoHost, STATUS_VARIABLE, type Status } from "@achq/core";
import { GitHubClient } from "../lib/client.ts";
import { PROVIDER } from "../lib/constants.ts";
import type { GitHubUrls } from "../lib/urls.ts";
import { ghToken, userGitHub } from "../lib/user.ts";
import type { RepoPolicyData } from "../resources/repo-policy.ts";
import { DEPLOYER_PERMISSIONS, REPO_NAME } from "./constants.ts";
import { lastCommit } from "./last-commit.ts";
import { repoOf } from "./remote.ts";
import { readStatus } from "./status.ts";

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

export const githubRepos = ({ api, web }: GitHubUrls): RepoHost => {
  const gh = userGitHub(api);
  return {
    repoName: REPO_NAME,
    deployerPolicy: (source, repo): RepoPolicyData => ({ provider: PROVIDER, app: source, repo, permissions: { ...DEPLOYER_PERMISSIONS } }),
    repo: (repo: string, credential: Credential) => repoClient(repo, credential.value, api),
    async canPush(repo, token) {
      const res = await new GitHubClient(`Bearer ${token}`, api).raw("GET", `/repos/${repo}`);
      if (!res.ok) return false;
      const data = (await res.json()) as { permissions?: { push?: boolean } };
      return data.permissions?.push === true;
    },
    cloneUrl: (repo) => `${web}/${repo}.git`,
    repoOf: (remote) => repoOf(remote, web),
    token: ghToken,
    status: (repo) => readStatus(gh, repo),
    lastCommit: (repo, branch, paths) => lastCommit(gh, repo, branch, paths),
  };
};

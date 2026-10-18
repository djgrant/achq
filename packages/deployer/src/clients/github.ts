// What the deployer reads from and writes to a repo on GitHub, with the
// repo-scoped token the router minted for it.
import { STATUS_VARIABLE } from "@achq/core";
import type { Status } from "@achq/core";
import { GitHubClient } from "@achq/github/api";

export type AchqTree = {
  commit: string;
  branch: string;
  /** The `.achq` tree's sha, or undefined when the commit has no `.achq/`. */
  tree?: string;
  /** Every blob under `.achq/`, by path relative to it. */
  blobs: Map<string, { sha: string; size: number }>;
};

export type FileLimits = { maxFiles: number; maxBytes: number };
export const DEFAULT_FILE_LIMITS: FileLimits = { maxFiles: 200, maxBytes: 1024 * 1024 };

type TreeEntry = { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number };

export const githubRepo = (repo: string, token: string, baseUrl?: string) => {
  const gh = new GitHubClient(`token ${token}`, baseUrl);
  const route = `/repos/${repo}`;

  return {
    /** The default branch's head, and the `.achq` tree in it. */
    async achqTree(): Promise<AchqTree> {
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

    /** Downloads `paths` (relative to `.achq/`) as UTF-8, within `limits`. */
    async download(tree: AchqTree, paths: string[], limits: FileLimits = DEFAULT_FILE_LIMITS): Promise<Record<string, string>> {
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

    /** Creates or updates the ACHQ_STATUS repository variable. */
    async writeStatus(status: Status) {
      const value = JSON.stringify(status);
      const res = await gh.raw("PATCH", `${route}/actions/variables/${STATUS_VARIABLE}`, { name: STATUS_VARIABLE, value });
      if (res.status === 404) await gh.request("POST", `${route}/actions/variables`, { name: STATUS_VARIABLE, value });
      else if (!res.ok) throw new Error(`Writing ${STATUS_VARIABLE}: GitHub ${res.status} ${(await res.text()).slice(0, 300)}`);
    },
  };
};

export type GitHubRepo = ReturnType<typeof githubRepo>;

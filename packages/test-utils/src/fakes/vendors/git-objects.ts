import { createHash } from "node:crypto";

/** One entry of a tree listing, as GitHub's git/trees endpoint returns it. A recursive listing's paths are from the listed tree. */
export type TreeEntry = { path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number };

/** Where a fake code host reads a repo's git objects from. Every sha is a full 40-character one; each method is `undefined` for what isn't there. */
export interface GitObjects {
  /** The commit `branch` points to. */
  head(branch: string): string | undefined;
  /** The tree of `commit`. */
  treeOf(commit: string): string | undefined;
  list(tree: string, recursive: boolean): TreeEntry[] | undefined;
  blob(sha: string): Buffer | undefined;
}

const git = (gitDir: string, args: string[]) => {
  const result = Bun.spawnSync(["git", "--git-dir", gitDir, ...args], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout : undefined;
};

/** The objects of the git repository at `gitDir` (bare or not), read with `git`. */
export const gitDirObjects = (gitDir: string) => ({
  head: (branch) => git(gitDir, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])?.toString().trim(),
  treeOf: (commit) => git(gitDir, ["rev-parse", "-q", "--verify", `${commit}^{tree}`])?.toString().trim(),
  list: (tree, recursive) => {
    const out = git(gitDir, ["ls-tree", "-l", "-z", ...(recursive ? ["-r", "-t"] : []), tree]);
    return out
      ?.toString()
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t") as [string, string];
        const [mode, type, sha, size] = meta.split(/\s+/) as [string, "blob" | "tree", string, string];
        return { path, mode, type, sha, ...(type === "blob" && { size: Number(size) }) };
      });
  },
  blob: (sha) => {
    const content = git(gitDir, ["cat-file", "blob", sha]);
    return content && Buffer.from(content);
  },
}) satisfies GitObjects;

type Obj = { type: "blob"; content: Buffer } | { type: "tree"; entries: TreeEntry[] } | { type: "commit"; tree: string };

const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");

/** Git objects kept in memory, written a whole commit at a time. */
export class MemoryGitObjects implements GitObjects {
  private readonly objects = new Map<string, Obj>();
  private readonly heads = new Map<string, string>();

  /** Commits `files`, the repo's whole content, to `branch`. Returns the commit's sha. */
  commit(files: Record<string, string>, branch = "main") {
    const tree = this.writeTree(files);
    const sha = sha1(`commit ${tree}\nparent ${this.heads.get(branch) ?? ""}\n${this.objects.size}`);
    this.objects.set(sha, { type: "commit", tree });
    this.heads.set(branch, sha);
    return sha;
  }

  head(branch: string) {
    return this.heads.get(branch);
  }

  treeOf(commit: string) {
    const c = this.objects.get(commit);
    return c?.type === "commit" ? c.tree : undefined;
  }

  list(tree: string, recursive: boolean, prefix = ""): TreeEntry[] | undefined {
    const t = this.objects.get(tree);
    if (t?.type !== "tree") return undefined;
    return t.entries.flatMap((e) => {
      const entry = { ...e, path: prefix + e.path };
      return recursive && e.type === "tree" ? [entry, ...this.list(e.sha, true, `${entry.path}/`)!] : [entry];
    });
  }

  blob(sha: string) {
    const b = this.objects.get(sha);
    return b?.type === "blob" ? b.content : undefined;
  }

  private writeTree(files: Record<string, string>): string {
    const here: Record<string, string> = {};
    const dirs: Record<string, Record<string, string>> = {};
    for (const [path, content] of Object.entries(files)) {
      const [head, ...rest] = path.split("/");
      if (rest.length) (dirs[head!] ??= {})[rest.join("/")] = content;
      else here[head!] = content;
    }
    const entries: TreeEntry[] = [];
    for (const [name, content] of Object.entries(here)) {
      const buf = Buffer.from(content);
      const sha = sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
      this.objects.set(sha, { type: "blob", content: buf });
      entries.push({ path: name, mode: "100644", type: "blob", sha, size: buf.length });
    }
    for (const [name, sub] of Object.entries(dirs)) entries.push({ path: name, mode: "040000", type: "tree", sha: this.writeTree(sub) });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const sha = sha1(`tree ${JSON.stringify(entries)}`);
    this.objects.set(sha, { type: "tree", entries });
    return sha;
  }
}

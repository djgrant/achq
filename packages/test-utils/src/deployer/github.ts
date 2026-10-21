import { createHash } from "node:crypto";

type Obj = { type: "blob"; content: Buffer } | { type: "tree"; entries: { path: string; mode: string; type: "blob" | "tree"; sha: string }[] } | { type: "commit"; tree: string };
type FakeRepo = { full_name: string; default_branch: string; heads: Map<string, string>; variables: Map<string, string> };

const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");

export class FakeGitHub {
  readonly objects = new Map<string, Obj>();
  readonly repos = new Map<string, FakeRepo>();
  /** token → repo it was minted for. */
  readonly tokens = new Map<string, string>();
  readonly requests: { method: string; path: string }[] = [];
  readonly server = Bun.serve({ port: 0, fetch: (req) => this.fetch(req) });
  get url() {
    return `http://localhost:${this.server.port}`;
  }

  stop() {
    this.server.stop(true);
  }

  /** Commits `files` (the repo's whole content) to the default branch. Returns the commit sha. */
  commit(repo: string, files: Record<string, string>, branch = "main") {
    let r = this.repos.get(repo.toLowerCase());
    if (!r) this.repos.set(repo.toLowerCase(), (r = { full_name: repo, default_branch: branch, heads: new Map(), variables: new Map() }));
    const tree = this.writeTree(files);
    const sha = sha1(`commit ${tree} ${this.objects.size} ${Math.random()}`);
    this.objects.set(sha, { type: "commit", tree });
    r.heads.set(branch, sha);
    return sha;
  }

  variable(repo: string, name: string) {
    const value = this.repos.get(repo.toLowerCase())?.variables.get(name);
    return value === undefined ? undefined : JSON.parse(value);
  }

  private writeTree(files: Record<string, string>): string {
    const here: Record<string, string> = {};
    const dirs: Record<string, Record<string, string>> = {};
    for (const [path, content] of Object.entries(files)) {
      const [head, ...rest] = path.split("/");
      if (rest.length) (dirs[head!] ??= {})[rest.join("/")] = content;
      else here[head!] = content;
    }
    const entries: Extract<Obj, { type: "tree" }>["entries"] = [];
    for (const [name, content] of Object.entries(here)) {
      const buf = Buffer.from(content);
      const sha = sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
      this.objects.set(sha, { type: "blob", content: buf });
      entries.push({ path: name, mode: "100644", type: "blob", sha });
    }
    for (const [name, sub] of Object.entries(dirs)) entries.push({ path: name, mode: "040000", type: "tree", sha: this.writeTree(sub) });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const sha = sha1(`tree ${JSON.stringify(entries)}`);
    this.objects.set(sha, { type: "tree", entries });
    return sha;
  }

  private listing(sha: string, recursive: boolean, prefix = ""): { path: string; mode: string; type: string; sha: string; size?: number }[] {
    const tree = this.objects.get(sha);
    if (tree?.type !== "tree") return [];
    return tree.entries.flatMap((e) => {
      const path = prefix + e.path;
      const blob = this.objects.get(e.sha);
      const entry = { path, mode: e.mode, type: e.type, sha: e.sha, ...(blob?.type === "blob" && { size: blob.content.length }) };
      return recursive && e.type === "tree" ? [entry, ...this.listing(e.sha, true, `${path}/`)] : [entry];
    });
  }

  private async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.requests.push({ method: req.method, path: url.pathname + url.search });
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const repo = this.repos.get(decodeURIComponent(m[1]!).toLowerCase());
    const token = req.headers.get("authorization")?.replace(/^token /i, "");
    if (!token || this.tokens.get(token)?.toLowerCase() !== decodeURIComponent(m[1]!).toLowerCase()) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (!repo) return Response.json({ message: "Not Found" }, { status: 404 });
    const rest = m[2] ?? "";
    const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });
    let r: RegExpExecArray | null;
    if (req.method === "GET" && rest === "") return Response.json({ full_name: repo.full_name, default_branch: repo.default_branch });
    if (req.method === "GET" && (r = /^\/git\/ref\/heads(?:\/|%2F)(.+)$/i.exec(rest))) {
      const sha = repo.heads.get(decodeURIComponent(r[1]!));
      return sha ? Response.json({ object: { sha, type: "commit" } }) : notFound();
    }
    if (req.method === "GET" && (r = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const c = this.objects.get(r[1]!);
      return c?.type === "commit" ? Response.json({ sha: r[1], tree: { sha: c.tree } }) : notFound();
    }
    if (req.method === "GET" && (r = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest))) {
      if (this.objects.get(r[1]!)?.type !== "tree") return notFound();
      return Response.json({ sha: r[1], tree: this.listing(r[1]!, url.searchParams.get("recursive") === "1"), truncated: false });
    }
    if (req.method === "GET" && (r = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest))) {
      const b = this.objects.get(r[1]!);
      return b?.type === "blob" ? Response.json({ sha: r[1], content: b.content.toString("base64"), encoding: "base64", size: b.content.length }) : notFound();
    }
    if (req.method === "PATCH" && (r = /^\/actions\/variables\/([^/]+)$/.exec(rest))) {
      if (!repo.variables.has(r[1]!)) return notFound();
      repo.variables.set(r[1]!, ((await req.json()) as { value: string }).value);
      return new Response(null, { status: 204 });
    }
    if (req.method === "POST" && rest === "/actions/variables") {
      const { name, value } = (await req.json()) as { name: string; value: string };
      if (repo.variables.has(name)) return Response.json({ message: "Already exists" }, { status: 409 });
      repo.variables.set(name, value);
      return new Response(null, { status: 201 });
    }
    return notFound();
  }
}

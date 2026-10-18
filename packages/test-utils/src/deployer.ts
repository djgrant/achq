// Fakes for the deployer's tests. GitHub and the router are real HTTP servers,
// and the router checks admin signatures. The container host is in memory.
import { createHash } from "node:crypto";
import type { Installation, MintRequest, SourceSettings, ValidateRequest, PolicyData, ContainerHost, ContainerSpec, RouterRepoConfig, ServiceState } from "@achq/core";
import { adminSecret, verifySigned } from "@achq/core/secrets";

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
    const token = req.headers.get("authorization")?.replace(/^token /, "");
    if (!token || this.tokens.get(token)?.toLowerCase() !== decodeURIComponent(m[1]!).toLowerCase()) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (!repo) return Response.json({ message: "Not Found" }, { status: 404 });
    const rest = m[2] ?? "";
    const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });
    let r: RegExpExecArray | null;
    if (req.method === "GET" && rest === "") return Response.json({ full_name: repo.full_name, default_branch: repo.default_branch });
    if (req.method === "GET" && (r = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
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

/** The router's admin endpoints, checking every request's admin signature. */
export class FakeRouter {
  installations: Installation[] = [];
  sources: SourceSettings[] = [];
  /** Problems `/admin/validate` reports for a policy. */
  problems: (policy: PolicyData, repo: string) => string[] = () => [];
  readonly repos = new Map<string, RouterRepoConfig>();
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  readonly mints: MintRequest[] = [];
  readonly validations: ValidateRequest[] = [];
  rejected = 0;
  readonly server = Bun.serve({ port: 0, fetch: (req) => this.fetch(req) });
  private n = 0;

  constructor(
    private key: string,
    private github: FakeGitHub,
  ) {}

  get url() {
    return `http://localhost:${this.server.port}`;
  }

  stop() {
    this.server.stop(true);
  }

  count(method: string, prefix: string) {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(prefix)).length;
  }

  private async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const text = await req.text();
    if (!verifySigned(adminSecret(this.key), req.method, path, text, req.headers)) {
      this.rejected++;
      return new Response("bad signature", { status: 401 });
    }
    const body = text ? JSON.parse(text) : undefined;
    this.calls.push({ method: req.method, path, body });
    let m: RegExpExecArray | null;
    if (req.method === "POST" && path === "/admin/mint") {
      const request = body as MintRequest;
      this.mints.push(request);
      const value = `tok-${++this.n}`;
      this.github.tokens.set(value, request.repo);
      return Response.json([{ provider: "github", value, expiresAt: new Date(Date.now() + 3600_000).toISOString(), scope: { repos: [request.repo] } }]);
    }
    if (req.method === "POST" && path === "/admin/validate") {
      const request = body as ValidateRequest;
      this.validations.push(request);
      return Response.json({ problems: request.policies.flatMap((p) => this.problems(p, request.repo)) });
    }
    if ((m = /^\/admin\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname))) {
      const repo = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
      if (req.method === "PUT") {
        this.repos.set(repo.toLowerCase(), body as RouterRepoConfig);
        return new Response(null, { status: 204 });
      }
      if (req.method === "DELETE") {
        if (!this.repos.delete(repo.toLowerCase())) return new Response("not found", { status: 404 });
        return new Response(null, { status: 204 });
      }
    }
    if (req.method === "GET" && path === "/admin/repos") return Response.json([...this.repos.values()]);
    if (req.method === "GET" && path === "/admin/installations") return Response.json(this.installations);
    if (req.method === "GET" && path === "/admin/sources") return Response.json(this.sources);
    return new Response("not found", { status: 404 });
  }
}

/** Records what the deployer asks of the host. */
export class MemoryContainerHost implements ContainerHost {
  readonly services = new Map<string, { spec: ContainerSpec; builds: number }>();
  readonly calls: { op: "ensure" | "deploy" | "remove"; repo: string; name: string }[] = [];

  private id = (repo: string, name: string) => `${repo.toLowerCase()}/${name}`;

  /** Containers that exist without the deployer having made them in this test, e.g. from an earlier run. */
  seed(repo: string, name: string) {
    this.services.set(this.id(repo, name), { spec: { repo, name, dockerfile: ".achq/Dockerfile", branch: "main", env: {} }, builds: 1 });
  }

  ops(op?: "ensure" | "deploy" | "remove") {
    return this.calls.filter((c) => !op || c.op === op);
  }

  async ensure(spec: ContainerSpec) {
    this.calls.push({ op: "ensure", repo: spec.repo, name: spec.name });
    const existing = this.services.get(this.id(spec.repo, spec.name));
    this.services.set(this.id(spec.repo, spec.name), { spec, builds: existing?.builds ?? 0 });
    return { url: `http://${spec.name}.${spec.repo.replace("/", "-").toLowerCase()}.internal:3000`, service: this.id(spec.repo, spec.name) };
  }
  async deploy(repo: string, name: string) {
    this.calls.push({ op: "deploy", repo, name });
    const s = this.services.get(this.id(repo, name));
    if (!s) throw new Error(`no service ${repo}/${name}`);
    s.builds++;
  }
  async state(repo: string, name: string): Promise<ServiceState> {
    return this.services.has(this.id(repo, name)) ? "running" : "missing";
  }
  async list() {
    return [...this.services.values()].map(({ spec }) => ({ repo: spec.repo, name: spec.name, service: this.id(spec.repo, spec.name) }));
  }
  async remove(repo: string, name: string) {
    this.calls.push({ op: "remove", repo, name });
    this.services.delete(this.id(repo, name));
  }
  async locate(repo: string, name: string) {
    return { platform: "memory", service: this.id(repo, name) };
  }
}

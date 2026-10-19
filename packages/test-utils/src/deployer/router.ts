import type { InstalledRepo, MintRequest, PolicyData, RouterRepoConfig, SourceSettings, ValidateRequest } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { verifySigned } from "@achq/core/signing";
import type { FakeGitHub } from "./github.ts";

/** The router's admin endpoints, checking every request's admin signature. */
export class FakeRouter {
  installed: InstalledRepo[] = [];
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
    if (req.method === "GET" && path === "/admin/installed") return Response.json(this.installed);
    if (req.method === "GET" && path === "/admin/sources") return Response.json(this.sources);
    return new Response("not found", { status: 404 });
  }
}

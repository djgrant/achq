import type { InstalledRepo, MintRequest, PolicyData, RouterRepoConfig, SourceSettings, ValidateRequest } from "@achq/core";
import { routerAdminRoutes as routes } from "@achq/core/routes/router-admin";
import { adminSecret } from "@achq/core/secrets";
import { verifySigned } from "@achq/core/signing";
import { handler } from "@achq/utils/http";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { FakeGitHub } from "../github.ts";

/** The router's admin routes the deployer calls, as `@achq/core/routes/router-admin` declares them, checking every request's admin signature. */
export class FakeRouter {
  installed: InstalledRepo[] = [];
  sources: SourceSettings[] = [];
  problems: (policy: PolicyData, repo: string) => string[] = () => [];
  readonly repos = new Map<string, RouterRepoConfig>();
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  readonly mints: MintRequest[] = [];
  readonly validations: ValidateRequest[] = [];
  rejected = 0;
  readonly server = Bun.serve({ port: 0, fetch: this.app().fetch });
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

  private app() {
    const admin = new OpenAPIHono();
    admin.use(async (c, next) => {
      const url = new URL(c.req.url);
      const path = url.pathname + url.search;
      const text = await c.req.text();
      if (!verifySigned(adminSecret(this.key), c.req.method, path, text, c.req.raw.headers)) {
        this.rejected++;
        return c.text("bad signature", 401);
      }
      this.calls.push({ method: c.req.method, path, body: text ? JSON.parse(text) : undefined });
      await next();
    });
    admin.openapi(routes.mint, (c) => {
      const request = c.req.valid("json");
      this.mints.push(request);
      const value = `tok-${++this.n}`;
      // A token for the repo with what its GitHub policies ask for, as the router's GitHub policy provider would mint.
      const permissions = Object.assign({}, ...request.policies.filter((p) => p.provider === "github").map((p) => p.permissions as Record<string, string>));
      this.github.grant(value, [request.repo], permissions);
      return c.json([{ provider: "github", value, expiresAt: new Date(Date.now() + 3600_000).toISOString(), scope: { repos: [request.repo] } }], 200);
    });
    admin.openapi(routes.validate, (c) => {
      const request = c.req.valid("json");
      this.validations.push(request);
      return c.json({ problems: request.policies.flatMap((p) => this.problems(p, request.repo)) }, 200);
    });
    admin.openapi(
      routes.putRepo,
      handler(routes.putRepo, (c) => {
        const { owner, name } = c.req.valid("param");
        this.repos.set(`${owner}/${name}`.toLowerCase(), c.req.valid("json"));
        return c.body(null, 204);
      }),
    );
    admin.openapi(
      routes.deleteRepo,
      handler(routes.deleteRepo, (c) => {
        const { owner, name } = c.req.valid("param");
        this.repos.delete(`${owner}/${name}`.toLowerCase());
        return c.body(null, 204);
      }),
    );
    admin.openapi(routes.installed, (c) => c.json(this.installed, 200));
    admin.openapi(routes.sources, (c) => c.json(this.sources, 200));
    return new OpenAPIHono().route("/admin", admin);
  }
}

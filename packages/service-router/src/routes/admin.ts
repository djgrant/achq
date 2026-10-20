// Admin-signed requests from the deployer and the infra CLI: repo config, the
// deployer's own access, what the router knows, failed deliveries, and
// requests for the deployer.
import type { MintRequest, ValidateRequest } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { verifyAdminRequest } from "@achq/core/signing";
import { jsonResponse, noContent, parseBody, textResponse } from "@achq/utils/http";
import { ADMIN_REPO_PREFIX, REPO } from "../constants.ts";
import type { RouterContext } from "../context.ts";
import { listFailed, replayFailed } from "../failed.ts";
import { mint, validate } from "../policies.ts";
import { fetchSigned, reach } from "../reach.ts";
import { policiesRequestSchema, repoConfigSchema } from "../requests.ts";
import { repoFile, repoKey } from "../store.ts";

type Route = (ctx: RouterContext, body: string) => Promise<Response>;
type RepoRoute = (ctx: RouterContext, repo: string, body: string) => Promise<Response>;

/** JSON unless it says otherwise. */
const relay = async (res: Response) =>
  new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });

const toDeployer = async (ctx: RouterContext, method: string, path: string, body?: string) => {
  const url = `${ctx.deployerUrl}${path}`;
  const result = await reach(ctx.delays, (signal) => fetchSigned(ctx, adminSecret(ctx.key), method, url, body, signal));
  return result.ok ? relay(result.res) : textResponse(result.error, 504);
};

const putRepo: RepoRoute = async (ctx, repo, body) => {
  const config = parseBody(repoConfigSchema, body);
  if (!config || repoKey(config.repo) !== repoKey(repo)) return textResponse("bad config", 400);
  // Written before it's live, so what's served is always what a restart would load.
  await ctx.store.repos.write(repoFile(repo), config);
  ctx.repos.set(repoKey(repo), config);
  return noContent();
};

const deleteRepo: RepoRoute = async (ctx, repo) => {
  // Claims are kept: reinstalling brings everything back as it was.
  await ctx.store.repos.remove(repoFile(repo));
  ctx.repos.delete(repoKey(repo));
  return noContent();
};

const REPO_ROUTES = new Map<string, RepoRoute>([
  ["PUT", putRepo],
  ["DELETE", deleteRepo],
]);

const allInstalled = async (ctx: RouterContext) => (await Promise.all(Object.values(ctx.codeHostProviders).map((h) => h.installed()))).flat();

const allSources = async (ctx: RouterContext) => (await Promise.all(ctx.channelProviders.map((c) => c.sources()))).flat();

const withPolicies =
  (answer: (ctx: RouterContext, request: MintRequest | ValidateRequest) => Promise<unknown>): Route =>
  async (ctx, body) => {
    const request = parseBody(policiesRequestSchema, body);
    return request ? jsonResponse(await answer(ctx, request)) : textResponse("bad request", 400);
  };

/** By `<method> <path>`. */
const ROUTES = new Map<string, Route>([
  ["GET /admin/repos", async (ctx) => jsonResponse([...ctx.repos.values()])],
  ["POST /admin/mint", withPolicies((ctx, r) => mint(ctx, r.policies, r.repo))],
  ["POST /admin/validate", withPolicies(async (ctx, r) => ({ problems: await validate(ctx, r.policies, r.repo) }))],
  ["GET /admin/installed", async (ctx) => jsonResponse(await allInstalled(ctx))],
  ["GET /admin/sources", async (ctx) => jsonResponse(await allSources(ctx))],
  ["POST /admin/sync", (ctx, body) => toDeployer(ctx, "POST", "/sync", body)],
  ["GET /admin/status", (ctx) => toDeployer(ctx, "GET", "/status")],
  ["GET /admin/failed", async (ctx) => jsonResponse(await listFailed(ctx))],
  ["POST /admin/failed/replay", async (ctx) => jsonResponse(await replayFailed(ctx))],
]);

const repoInPath = (pathname: string) => {
  const rest = pathname.startsWith(ADMIN_REPO_PREFIX) ? pathname.slice(ADMIN_REPO_PREFIX.length) : undefined;
  return rest !== undefined && REPO.test(rest) ? rest : undefined;
};

export const admin = async (ctx: RouterContext, req: Request) => {
  const verified = await verifyAdminRequest(req, ctx.key, ctx.now());
  if (!verified) return textResponse("bad signature", 401);
  const { pathname } = new URL(req.url);
  const repo = repoInPath(pathname);
  const route = repo ? REPO_ROUTES.get(req.method) : undefined;
  if (repo && route) return route(ctx, repo, verified.body);
  return (await ROUTES.get(`${req.method} ${pathname}`)?.(ctx, verified.body)) ?? textResponse("not found", 404);
};

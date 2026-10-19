import type { MintRequest, RouterRepoConfig, ValidateRequest } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { verifySigned } from "@achq/core/signing";
import { mint, validate } from "../policies.ts";
import type { RouterContext } from "../context.ts";
import { json, noContent, parse, text } from "../http.ts";
import { reach, signed } from "../reach.ts";
import { repoFile } from "../store.ts";

/** Forwards to the deployer, waking it, and passes its answer back. */
const toDeployer = async (ctx: RouterContext, method: string, path: string, body?: string) => {
  const url = `${ctx.deployerUrl}${path}`;
  const result = await reach(ctx, (signal) => ctx.fetch(url, signed(ctx, adminSecret(ctx.key), method, url, body, signal)));
  if (!result.ok) return text(result.error, 504);
  return new Response(await result.res.text(), { status: result.res.status, headers: { "content-type": result.res.headers.get("content-type") ?? "application/json" } });
};

const putRepo = async (ctx: RouterContext, path: string, body: string) => {
  const config = parse<RouterRepoConfig>(body);
  const valid =
    typeof config?.host === "string" &&
    config.repo?.toLowerCase() === path.toLowerCase() &&
    typeof config.commit === "string" &&
    [config.containers, config.workspaces, config.triggers].every(Array.isArray);
  if (!valid) return text("bad config", 400);
  // Written before it's live, so what's served is always what a restart would load.
  await ctx.store.write("repos", repoFile(path), config);
  ctx.repos.set(path.toLowerCase(), config as RouterRepoConfig);
  return noContent();
};

const deleteRepo = async (ctx: RouterContext, path: string) => {
  // Claims are kept: reinstalling brings everything back as it was.
  await ctx.store.remove("repos", repoFile(path));
  ctx.repos.delete(path.toLowerCase());
  return noContent();
};

/** Admin-signed requests from the deployer and the infra CLI. */
export const admin = async (ctx: RouterContext, req: Request) => {
  const url = new URL(req.url);
  const body = await req.text();
  if (!verifySigned(adminSecret(ctx.key), req.method, url.pathname + url.search, body, req.headers, ctx.now())) return text("bad signature", 401);
  const repoPath = url.pathname.match(/^\/admin\/repos\/([\w.-]+\/[\w.-]+)$/)?.[1];

  if (repoPath && req.method === "PUT") return putRepo(ctx, repoPath, body);
  if (repoPath && req.method === "DELETE") return deleteRepo(ctx, repoPath);
  switch (`${req.method} ${url.pathname}`) {
    case "GET /admin/repos":
      return json([...ctx.repos.values()]);
    case "POST /admin/mint": {
      const request = parse<MintRequest>(body);
      if (typeof request?.repo !== "string" || !Array.isArray(request.policies)) return text("bad request", 400);
      return json(await mint(ctx, request.policies, request.repo));
    }
    case "POST /admin/validate": {
      const request = parse<ValidateRequest>(body);
      if (typeof request?.repo !== "string" || !Array.isArray(request.policies)) return text("bad request", 400);
      return json({ problems: await validate(ctx, request.policies, request.repo) });
    }
    case "GET /admin/installations":
      return json((await Promise.all(ctx.installationProviders.map((p) => p.installations()))).flat());
    case "GET /admin/sources":
      return json((await Promise.all(ctx.channels.map((c) => c.sources()))).flat());
    case "POST /admin/sync":
      return toDeployer(ctx, "POST", "/sync", body);
    case "GET /admin/status":
      return toDeployer(ctx, "GET", "/status");
  }
  return text("not found", 404);
};

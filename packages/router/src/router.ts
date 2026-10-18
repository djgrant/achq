/**
 * The router holds every App's key, so it stays small. It only parses JSON and
 * checks signatures. Everything else lives behind the interfaces it's handed.
 */
import type { RouterRepoConfig } from "@achq/core";
import { createContext, type RouterContext, type RouterDeps } from "./context.ts";
import { message } from "./errors.ts";
import { text } from "./http.ts";
import { replay, settled } from "./inbox.ts";
import { admin } from "./routes/admin.ts";
import { claim, credentials } from "./routes/containers.ts";
import { wake } from "./routes/wake.ts";
import { webhook } from "./routes/webhook.ts";
import type { Claims } from "./targets.ts";

type Handle = (ctx: RouterContext, req: Request, pathname: string) => Promise<Response | undefined> | undefined;

/** Health on `/`, 404 for anything unhandled, and a 500 that doesn't leak the error. */
const guarded = (ctx: RouterContext, handle: Handle) => async (req: Request) => {
  const { pathname } = new URL(req.url);
  if (req.method === "GET" && pathname === "/") return text("ok");
  try {
    return (await handle(ctx, req, pathname)) ?? text("not found", 404);
  } catch (e) {
    ctx.log(`${req.method} ${pathname}: ${message(e)}`);
    return text("internal error", 500);
  }
};

/** Loads config and claims from the volume. */
const load = async (ctx: RouterContext) => {
  for (const name of await ctx.store.list("repos")) {
    const config = await ctx.store.read<RouterRepoConfig>("repos", name);
    if (config) ctx.repos.set(config.repo.toLowerCase(), config);
  }
  for (const name of await ctx.store.list("claims")) {
    const repoClaims = await ctx.store.read<Claims>("claims", name);
    if (repoClaims) ctx.claims.set(name.replace("__", "/"), repoClaims);
  }
};

export const createRouter = (deps: RouterDeps) => {
  const ctx = createContext(deps);

  /** Webhooks, `/wake`, and admin for the infra CLI. Never credentials or claims. */
  const publicFetch = guarded(ctx, (ctx, req, pathname) => {
    if (req.method === "POST" && pathname === "/webhook") return webhook(ctx, req);
    if (req.method === "POST" && pathname === "/wake") return wake(ctx, req);
    if (pathname.startsWith("/admin/")) return admin(ctx, req);
  });

  /** Reached only over the private network: containers and the deployer. */
  const privateFetch = guarded(ctx, (ctx, req, pathname) => {
    if (req.method === "POST" && pathname === "/credentials") return credentials(ctx, req);
    if (req.method === "POST" && pathname === "/claims") return claim(ctx, req);
    if (pathname.startsWith("/admin/")) return admin(ctx, req);
  });

  return {
    publicFetch,
    privateFetch,
    /** Loads config and claims from the volume, then replays the inbox in the background. Call before serving. */
    start: async () => {
      await load(ctx);
      await replay(ctx);
    },
    replay: () => replay(ctx),
    settled: () => settled(ctx),
  };
};

export type Router = ReturnType<typeof createRouter>;

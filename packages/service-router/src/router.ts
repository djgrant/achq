import { withHealthAndErrors } from "@achq/utils/http";
import { ADMIN_PREFIX } from "./constants.ts";
import { createContext, type RouterContext, type RouterDeps } from "./context.ts";
import { replay, settled } from "./inbox.ts";
import { admin } from "./routes/admin.ts";
import { claim, credentials } from "./routes/containers.ts";
import { wake } from "./routes/wake.ts";
import { webhook } from "./routes/webhook.ts";
import { repoFromFile, repoKey } from "./store.ts";

type Route = (ctx: RouterContext, req: Request) => Promise<Response>;

/** Webhooks, `/wake`, and admin for the infra CLI. Never credentials or claims. */
const PUBLIC_ROUTES = new Map<string, Route>([
  ["POST /webhook", webhook],
  ["POST /wake", wake],
]);

/** Reached only over the private network: containers and the deployer. */
const PRIVATE_ROUTES = new Map<string, Route>([
  ["POST /credentials", credentials],
  ["POST /claims", claim],
]);

/** A handler for `routes`, by `<method> <path>`, and admin, which both ports serve. */
const serve = (ctx: RouterContext, routes: Map<string, Route>) =>
  withHealthAndErrors((req, url) => {
    if (url.pathname.startsWith(ADMIN_PREFIX)) return admin(ctx, req);
    return routes.get(`${req.method} ${url.pathname}`)?.(ctx, req);
  }, ctx.log);

const loadRepos = async (ctx: RouterContext) => {
  for (const config of await ctx.store.repos.all()) ctx.repos.set(repoKey(config.repo), config);
};

const loadClaims = async (ctx: RouterContext) => {
  for (const name of await ctx.store.claims.list()) {
    const repoClaims = await ctx.store.claims.read(name);
    if (repoClaims) ctx.claims.set(repoFromFile(name), repoClaims);
  }
};

export const createRouter = (deps: RouterDeps) => {
  const ctx = createContext(deps);
  return {
    publicFetch: serve(ctx, PUBLIC_ROUTES),
    privateFetch: serve(ctx, PRIVATE_ROUTES),
    /** Loads config and claims from the volume, then replays the inbox in the background. Call before serving. */
    start: async () => {
      await loadRepos(ctx);
      await loadClaims(ctx);
      await replay(ctx);
    },
    replay: () => replay(ctx),
    settled: () => settled(ctx),
  };
};

export type Router = ReturnType<typeof createRouter>;

import { service } from "@achq/utils/http";
import { createContext, type RouterDeps } from "./context.ts";
import { replay, settled } from "./inbox.ts";
import { admin } from "./routes/admin.ts";
import { containers } from "./routes/containers.ts";
import { wake } from "./routes/wake.ts";
import { webhook } from "./routes/webhook.ts";
import { repoFromFile, repoKey } from "./store.ts";

export const createRouter = (deps: RouterDeps) => {
  const ctx = createContext(deps);
  // Credentials and claims are only for the private network.
  const publicApp = service(ctx.log).route("/admin", admin(ctx)).route("/", webhook(ctx)).route("/", wake(ctx));
  const privateApp = service(ctx.log).route("/admin", admin(ctx)).route("/", containers(ctx));
  return {
    publicFetch: publicApp.fetch,
    privateFetch: privateApp.fetch,
    /** Loads config and claims from the volume, then replays the inbox in the background. Call before serving. */
    start: async () => {
      for (const config of await ctx.store.repos.all()) ctx.repos.set(repoKey(config.repo), config);
      for (const name of await ctx.store.claims.list()) {
        const repoClaims = await ctx.store.claims.read(name);
        if (repoClaims) ctx.claims.set(repoFromFile(name), repoClaims);
      }
      await replay(ctx);
    },
    replay: () => replay(ctx),
    settled: () => settled(ctx),
  };
};

export type Router = ReturnType<typeof createRouter>;

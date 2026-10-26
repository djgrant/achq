import { ENV, onlyCodeHost, providerNamed, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT, type Stores } from "@achq/core";
import { loadPlugins, parsePlugins, pluginsDir } from "@achq/core/plugins";
import { Env } from "@achq/utils/env";
import { createContext } from "./context.ts";
import { replay } from "./features/deliveries.ts";
import { routes } from "./routes.ts";

/** Listening on "::" lets private networks over IPv6 reach it, where its container provider has one. */
const ALL_INTERFACES = "::";

export const main = async () => {
  const env = new Env(process.env);
  const providers = await loadPlugins(parsePlugins(env.require(ENV.plugins)), pluginsDir(env.require(ENV.dataDir)));
  // Where it keeps what it stores: its container provider's store.
  const containerProvider = providerNamed("container provider", providers.containers, env.require(ENV.containerProvider));
  const stores: Stores = (collection) => containerProvider.store(env.vars, collection);
  const ctx = await createContext(
    { key: env.require(ENV.key), deployerUrl: env.require(ENV.deployerUrl) },
    {
      channelProviders: providers.channels.map((c) => c.create(env.vars)),
      policyProviders: providers.policies.map((p) => p.create(env.vars)),
      codeHost: onlyCodeHost(providers).create(env.vars),
      stores,
    },
  );
  // In the background: what the inbox kept across a restart is forwarded again.
  await replay(ctx);
  const { publicFetch, privateFetch } = routes(ctx);
  Bun.serve({ port: ROUTER_PUBLIC_PORT, hostname: ALL_INTERFACES, fetch: publicFetch });
  Bun.serve({ port: ROUTER_PRIVATE_PORT, hostname: ALL_INTERFACES, fetch: privateFetch });
  console.log(`achq router listening on :${ROUTER_PUBLIC_PORT} (public) and :${ROUTER_PRIVATE_PORT} (private)`);
};

if (import.meta.main) await main();

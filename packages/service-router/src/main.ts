import { ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT } from "@achq/core";
import { Env } from "@achq/utils/env";
import { CHANNEL_PROVIDERS, CODE_HOST, POLICY_PROVIDERS, serviceContainerProvider } from "@achq/registry";
import { createContext } from "./context.ts";
import { replay } from "./features/deliveries.ts";
import { routes } from "./routes.ts";

/** Listening on "::" lets private networks over IPv6 reach it, where its container provider has one. */
const ALL_INTERFACES = "::";

export const main = async () => {
  const env = new Env(process.env);
  const { stores } = serviceContainerProvider(env);
  const ctx = await createContext(
    { key: env.require(ENV.key), deployerUrl: env.require(ENV.deployerUrl) },
    {
      channelProviders: CHANNEL_PROVIDERS.map((c) => c.create(env.vars)),
      policyProviders: POLICY_PROVIDERS.map((p) => p.create(env.vars)),
      codeHost: CODE_HOST.create(env.vars),
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

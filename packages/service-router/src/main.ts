import { ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT } from "@achq/core";
import { Env } from "@achq/utils/env";
import { CHANNEL_PROVIDERS, codeHostProviders, POLICY_PROVIDERS, serviceContainerProvider } from "achq/registry";
import { createRouter } from "./router.ts";

/** Listening on "::" lets private networks over IPv6 reach it, where its container provider has one. */
const ALL_INTERFACES = "::";

export const main = async () => {
  const env = new Env(process.env);
  const { stores } = serviceContainerProvider(env);
  const router = createRouter({
    channelProviders: CHANNEL_PROVIDERS.map((c) => c.create(env.vars)),
    policyProviders: POLICY_PROVIDERS.map((p) => p.create(env.vars)),
    codeHostProviders: codeHostProviders(env.vars),
    key: env.require(ENV.key),
    deployerUrl: env.require(ENV.deployerUrl),
    stores,
  });
  // Loaded before serving, so no event is routed against an empty config.
  await router.start();
  Bun.serve({ port: ROUTER_PUBLIC_PORT, hostname: ALL_INTERFACES, fetch: router.publicFetch });
  Bun.serve({ port: ROUTER_PRIVATE_PORT, hostname: ALL_INTERFACES, fetch: router.privateFetch });
  console.log(`achq router listening on :${ROUTER_PUBLIC_PORT} (public) and :${ROUTER_PRIVATE_PORT} (private)`);
};

if (import.meta.main) await main();

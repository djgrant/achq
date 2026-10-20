import { ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT } from "@achq/core";
import { optionalEnv, requireEnv } from "@achq/utils/env";
import { CHANNEL_PROVIDERS, CODE_HOST_PROVIDERS, POLICY_PROVIDERS } from "achq/registry";
import { DEFAULT_DATA_DIR } from "./constants.ts";
import { createRouter } from "./router.ts";

/** Listening on "::" lets private networks over IPv6 reach it. */
const ALL_INTERFACES = "::";

export const main = async () => {
  const env = process.env;
  const router = createRouter({
    channelProviders: CHANNEL_PROVIDERS.map((c) => c.create(env)),
    policyProviders: POLICY_PROVIDERS.map((p) => p.create(env)),
    codeHostProviders: Object.fromEntries(CODE_HOST_PROVIDERS.map((h) => [h.id, h.create(env)])),
    key: requireEnv(env, ENV.key),
    deployerUrl: requireEnv(env, ENV.deployerUrl),
    dataDir: optionalEnv(env, ENV.dataDir) ?? DEFAULT_DATA_DIR,
  });
  // Loaded before serving, so no event is routed against an empty config.
  await router.start();
  Bun.serve({ port: ROUTER_PUBLIC_PORT, hostname: ALL_INTERFACES, fetch: router.publicFetch });
  Bun.serve({ port: ROUTER_PRIVATE_PORT, hostname: ALL_INTERFACES, fetch: router.privateFetch });
  console.log(`achq router listening on :${ROUTER_PUBLIC_PORT} (public) and :${ROUTER_PRIVATE_PORT} (private)`);
};

if (import.meta.main) await main();

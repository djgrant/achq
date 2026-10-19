import { ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT } from "@achq/core";
import { CHANNEL_PROVIDERS, CODE_HOST_PROVIDERS, POLICY_PROVIDERS } from "achq/registry";
import { DEFAULT_DATA_DIR } from "./constants.ts";
import { createRouter } from "./router.ts";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const main = async () => {
  const env = process.env;
  const key = need(ENV.key);
  const router = createRouter({
    channelProviders: CHANNEL_PROVIDERS.map((c) => c.create(env)),
    policyProviders: POLICY_PROVIDERS.map((p) => p.create(env)),
    codeHostProviders: Object.fromEntries(CODE_HOST_PROVIDERS.map((h) => [h.id, h.create(env)])),
    key,
    deployerUrl: need(ENV.deployerUrl),
    dataDir: env[ENV.dataDir] ?? DEFAULT_DATA_DIR,
  });
  // Loaded before serving, so no event is routed against an empty config.
  await router.start();
  // "::" so private networks over IPv6 reach it.
  Bun.serve({ port: ROUTER_PUBLIC_PORT, hostname: "::", fetch: router.publicFetch });
  Bun.serve({ port: ROUTER_PRIVATE_PORT, hostname: "::", fetch: router.privateFetch });
  console.log(`achq router listening on :${ROUTER_PUBLIC_PORT} (public) and :${ROUTER_PRIVATE_PORT} (private)`);
};

if (import.meta.main) await main();

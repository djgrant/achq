import { ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT } from "@achq/core";
import { ACCESS, CHANNELS, REPO_HOSTS } from "achq/registry";
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
    channels: CHANNELS.map((c) => c.create(env, key)),
    access: ACCESS.map((a) => a.create(env, key)),
    hosts: Object.fromEntries(REPO_HOSTS.map((h) => [h.id, h.create(env)])),
    key,
    deployerUrl: need(ENV.deployerUrl),
    dataDir: env[ENV.dataDir] ?? DEFAULT_DATA_DIR,
  });
  // Loaded before serving, so no event is routed against an empty config.
  await router.start();
  const publicPort = Number(env.PORT ?? ROUTER_PUBLIC_PORT);
  const privatePort = Number(env[ENV.privatePort] ?? ROUTER_PRIVATE_PORT);
  // "::" so private networks over IPv6 reach it.
  Bun.serve({ port: publicPort, hostname: "::", fetch: router.publicFetch });
  Bun.serve({ port: privatePort, hostname: "::", fetch: router.privateFetch });
  console.log(`achq router listening on :${publicPort} (public) and :${privatePort} (private)`);
};

if (import.meta.main) await main();

import { ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT, type RepoHost } from "@achq/core";
import { PROVIDERS } from "achq/registry";
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
  const sides = PROVIDERS.map((p) => p.router(env, key));
  const router = createRouter({
    channels: sides.flatMap((s) => (s.channel ? [s.channel] : [])),
    providers: sides.flatMap((s) => (s.access ? [s.access] : [])),
    hosts: Object.fromEntries(PROVIDERS.flatMap((p): [string, RepoHost][] => (p.repos ? [[p.id, p.repos(env)]] : []))),
    key,
    deployerUrl: need(ENV.deployerUrl),
    dataDir: env[ENV.dataDir] ?? DEFAULT_DATA_DIR,
    installations: async () => (await Promise.all(sides.map((s) => s.installations()))).flat(),
    sources: async () => (await Promise.all(sides.map((s) => s.sources()))).flat(),
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

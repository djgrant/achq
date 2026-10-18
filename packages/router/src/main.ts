import { ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT } from "@achq/core";
import { createGitHub, parseApps } from "@achq/github/runtime";
import { createRouter } from "./router.ts";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const main = async () => {
  const key = need(ENV.key);
  const github = createGitHub({ apps: parseApps(need(ENV.githubApps)), key });
  const router = createRouter({
    channels: [github.channel],
    providers: [github.access],
    key,
    deployerUrl: need(ENV.deployerUrl),
    dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH ?? process.env.DATA_DIR ?? "./data",
    installations: github.installations,
    sources: github.sources,
  });
  // Loaded before serving, so no event is routed against an empty config.
  await router.start();
  const publicPort = Number(process.env.PORT ?? ROUTER_PUBLIC_PORT);
  const privatePort = Number(process.env[ENV.privatePort] ?? ROUTER_PRIVATE_PORT);
  // "::" so Railway's private network (IPv6) reaches it.
  Bun.serve({ port: publicPort, hostname: "::", fetch: router.publicFetch });
  Bun.serve({ port: privatePort, hostname: "::", fetch: router.privateFetch });
  console.log(`achq router listening on :${publicPort} (public) and :${privatePort} (private)`);
};

if (import.meta.main) await main();

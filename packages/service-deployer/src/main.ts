import { DEPLOYER_PORT, ENV, onlyCodeHost, providerNamed, type Stores } from "@achq/core";
import { routerAdmin } from "@achq/core/clients/router";
import { configModules, loadPlugins, parsePlugins, pluginsDir } from "@achq/core/plugins";
import { Env } from "@achq/utils/env";
import { text } from "@achq/utils/text";
import pkg from "../package.json" with { type: "json" };
import { createContext } from "./context.ts";
import { evaluateConfig } from "./features/config/evaluate.ts";
import { routes } from "./routes.ts";

/** Bun's longest: a deploy that builds images can keep `/events` busy for minutes. */
const IDLE_TIMEOUT_S = 255;

export const main = async () => {
  const env = new Env(process.env);
  const key = env.require(ENV.key);
  const routerUrl = env.require(ENV.routerUrl);
  const containerEnv: Record<string, string> = JSON.parse(env.require(ENV.containerEnv));
  // Its own plugins, and the containers', whose packages the configs it evaluates may import.
  const plugins = parsePlugins(env.require(ENV.plugins));
  const containerPlugins = parsePlugins(containerEnv[ENV.plugins] ?? "[]");
  const dir = pluginsDir(env.require(ENV.dataDir));
  const providers = await loadPlugins([...plugins, ...containerPlugins.filter((c) => !plugins.some((p) => p.package === c.package))], dir);
  const containerProvider = providerNamed("container provider", providers.containers, env.require(ENV.containerProvider));
  const stores: Stores = (collection) => containerProvider.store(env.vars, collection);
  const allowed = configModules(containerPlugins, dir, Bun.resolveSync("@achq/core", import.meta.dir));

  const ctx = await createContext(
    {
      containerEnv,
      key,
      routerUrl,
      routerPublicUrl: env.require(ENV.routerPublicUrl),
      version: pkg.version,
      plugins,
      owners: text.commaList(env.require(ENV.owners)),
      runtimes: text.commaList(env.optional(ENV.runtimes) ?? ""),
    },
    {
      containerProvider: containerProvider.create(env.vars),
      router: routerAdmin({ url: routerUrl, key }),
      codeHost: onlyCodeHost(providers).create(env.vars),
      stores,
      evaluate: (files) => evaluateConfig(files, allowed),
    },
  );

  Bun.serve({ port: DEPLOYER_PORT, hostname: "::", idleTimeout: IDLE_TIMEOUT_S, fetch: routes(ctx).fetch });
  console.log(`deployer ${pkg.version} listening on ${DEPLOYER_PORT}`);
};

if (import.meta.main) await main();

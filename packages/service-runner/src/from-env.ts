import { ENV, privateEnv } from "@achq/core";
import { configModules, type Install, loadPlugins, parsePlugins, pluginsDir } from "@achq/core/plugins";
import { Env, type Vars } from "@achq/utils/env";
import { time } from "@achq/utils/time";
import { createConfigLoader } from "./features/config.ts";
import { paths as layout } from "./features/layout.ts";
import { fetchMirror } from "./features/repo.ts";
import { Runner } from "./features/runner.ts";
import { runtimesOf } from "./features/runtime-context.ts";

const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_MAX_RUNS = 2;
export const DEFAULT_RUN_TIMEOUT_MINUTES = 360;

/** The settings every command needs, from the container's environment (what the deployer's `ContainerSpec.env` sets). */
export const settings = (env: Env) => ({
  repo: env.require(ENV.repo),
  container: env.require(ENV.container),
  dataDir: env.optional(ENV.dataDir) ?? DEFAULT_DATA_DIR,
  repoUrl: env.require(ENV.repoUrl),
});

/** How many runs go at once and how long each may take, from the container's environment or their defaults. */
export const runLimits = (env: Env) => ({
  maxRuns: env.positiveInt(ENV.maxRuns, DEFAULT_MAX_RUNS),
  runTimeoutMs: env.positiveInt(ENV.runTimeoutMinutes, DEFAULT_RUN_TIMEOUT_MINUTES) * time.MINUTE_MS,
});

/**
 * The plugins the container's environment names, installed under its data dir
 * and loaded: their providers, what's never given to an agent, the agent
 * runtimes by id, and what a config may import: core, as this runner's own
 * copy, and the plugins.
 */
export const containerPlugins = async (vars: Vars, dataDir: string, options: { install?: Install } = {}) => {
  const plugins = parsePlugins(new Env(vars).require(ENV.plugins));
  const dir = pluginsDir(dataDir);
  const providers = await loadPlugins(plugins, dir, options);
  return {
    providers,
    privateEnv: privateEnv(providers),
    runtimes: runtimesOf(providers.agents),
    modules: configModules(plugins, dir, Bun.resolveSync("@achq/core", import.meta.dir)),
  };
};

/** The runner the container's environment describes, with the channel and policy providers of the plugins it names. */
export const runnerFromEnv = async (vars: Vars, options: { log?: (line: string) => void; install?: Install } = {}) => {
  const env = new Env(vars);
  const { repo, container, dataDir, repoUrl } = settings(env);
  const paths = layout(dataDir);
  const { providers, privateEnv, runtimes, modules } = await containerPlugins(vars, dataDir, options);
  let runner: Runner;
  const loadConfig = createConfigLoader({
    modules,
    mirror: paths.mirror,
    dir: paths.config,
    fetch: async () => fetchMirror(paths.mirror, repoUrl, { ...vars, ...(await runner.credentials.get()).env }),
  });
  runner = new Runner({
    repo,
    container,
    // Without the router's key or secrets: credentials come from the router.
    channelProviders: providers.channels.map((c) => c.create(vars)),
    policyProviders: providers.policies.map((p) => p.create(vars)),
    runtimes,
    privateEnv,
    routerUrl: env.require(ENV.routerUrl),
    containerSecret: env.require(ENV.containerSecret),
    dataDir,
    repoUrl,
    env: vars,
    ...runLimits(env),
    log: options.log,
    loadConfig,
  });
  return runner;
};

import { ENV } from "@achq/core";
import { Env, type Vars } from "@achq/utils/env";
import { time } from "@achq/utils/time";
import { CHANNEL_PROVIDERS, POLICY_PROVIDERS } from "achq/registry";
import { createConfigLoader } from "./config.ts";
import { DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES } from "./constants.ts";
import { fetchMirror } from "./repo.ts";
import { Runner } from "./runner.ts";
import { paths as layout } from "./volume.ts";

const DEFAULT_DATA_DIR = "/data";

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

export const createAgent = (vars: Vars, options: { log?: (line: string) => void } = {}) => {
  const env = new Env(vars);
  const { repo, container, dataDir, repoUrl } = settings(env);
  const paths = layout(dataDir);
  let runner: Runner;
  const loadConfig = createConfigLoader({
    mirror: paths.mirror,
    dir: paths.config,
    fetch: async () => fetchMirror(paths.mirror, repoUrl, { ...vars, ...(await runner.credentials.get()).env }),
  });
  runner = new Runner({
    repo,
    container,
    // Without the router's key or secrets: credentials come from the router.
    channelProviders: CHANNEL_PROVIDERS.map((c) => c.create(vars)),
    policyProviders: POLICY_PROVIDERS.map((p) => p.create(vars)),
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

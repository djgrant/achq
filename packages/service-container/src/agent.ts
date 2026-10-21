import { ENV } from "@achq/core";
import { Env, type Vars } from "@achq/utils/env";
import { CHANNEL_PROVIDERS, POLICY_PROVIDERS } from "achq/registry";
import { createConfigLoader } from "./config.ts";
import { DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES, MINUTE_MS } from "./constants.ts";
import { fetchMirror } from "./repo.ts";
import { Runner } from "./runner.ts";
import { paths as layout } from "./volume.ts";

const DEFAULT_DATA_DIR = "/data";
const MAX_RUNS_ENV = "ACHQ_MAX_RUNS";
const RUN_TIMEOUT_MINUTES_ENV = "ACHQ_RUN_TIMEOUT_MINUTES";

/** The settings every command needs, from the container's environment (what the deployer's `ContainerSpec.env` sets). */
export const settings = (vars: Vars) => {
  const env = new Env(vars);
  return {
    repo: env.require(ENV.repo),
    container: env.require(ENV.container),
    dataDir: env.optional(ENV.dataDir) ?? DEFAULT_DATA_DIR,
    repoUrl: env.require(ENV.repoUrl),
  };
};

export const createAgent = (env: Vars, options: { log?: (line: string) => void } = {}) => {
  const { repo, container, dataDir, repoUrl } = settings(env);
  const required = new Env(env);
  const paths = layout(dataDir);
  let runner: Runner;
  const loadConfig = createConfigLoader({
    mirror: paths.mirror,
    dir: paths.config,
    fetch: async () => fetchMirror(paths.mirror, repoUrl, { ...env, ...(await runner.credentials.get()).env }),
  });
  runner = new Runner({
    repo,
    container,
    // Without the router's key or secrets: credentials come from the router.
    channelProviders: CHANNEL_PROVIDERS.map((c) => c.create(env)),
    policyProviders: POLICY_PROVIDERS.map((p) => p.create(env)),
    routerUrl: required.require(ENV.routerUrl),
    containerSecret: required.require(ENV.containerSecret),
    dataDir,
    repoUrl,
    env,
    maxRuns: Number(env[MAX_RUNS_ENV] ?? DEFAULT_MAX_RUNS),
    runTimeoutMs: Number(env[RUN_TIMEOUT_MINUTES_ENV] ?? DEFAULT_RUN_TIMEOUT_MINUTES) * MINUTE_MS,
    log: options.log,
    loadConfig,
  });
  return runner;
};

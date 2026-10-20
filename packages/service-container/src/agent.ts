import { ENV } from "@achq/core";
import { requireEnv } from "@achq/utils/env";
import { CHANNEL_PROVIDERS, POLICY_PROVIDERS } from "achq/registry";
import { createConfigLoader } from "./config/loader.ts";
import { DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES, MAX_RUNS_ENV, MINUTE_MS, RUN_TIMEOUT_MINUTES_ENV } from "./constants.ts";
import { paths as layout } from "./paths.ts";
import { fetchMirror } from "./repo.ts";
import { Runner } from "./runner.ts";
import { type Env, settings } from "./settings.ts";

/** The serving runner, wired from the container's environment. */
export const createAgent = (env: Env, options: { log?: (line: string) => void } = {}) => {
  const { repo, container, dataDir, repoUrl } = settings(env);
  const paths = layout(dataDir);
  let runner: Runner;
  const gitEnv = async () => ({ ...env, ...(await runner.credentials.get()).env });
  const load = createConfigLoader({
    mirror: paths.mirror,
    dir: paths.config,
    fetch: async () => fetchMirror(paths.mirror, repoUrl, await gitEnv()),
  });
  runner = new Runner({
    repo,
    container,
    // Without the router's key or secrets: credentials come from the router.
    channelProviders: CHANNEL_PROVIDERS.map((c) => c.create(env)),
    policyProviders: POLICY_PROVIDERS.map((p) => p.create(env)),
    routerUrl: requireEnv(env, ENV.routerUrl),
    containerSecret: requireEnv(env, ENV.containerSecret),
    dataDir,
    repoUrl,
    env,
    maxRuns: Number(env[MAX_RUNS_ENV] ?? DEFAULT_MAX_RUNS),
    runTimeoutMs: Number(env[RUN_TIMEOUT_MINUTES_ENV] ?? DEFAULT_RUN_TIMEOUT_MINUTES) * MINUTE_MS,
    log: options.log,
    loadConfig: load,
  });
  return runner;
};

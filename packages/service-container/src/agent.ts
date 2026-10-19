import { ENV } from "@achq/core";
import { ACCESS, CHANNELS } from "achq/registry";
import { createConfigLoader } from "./config/loader.ts";
import { DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES } from "./constants.ts";
import { paths as layout } from "./paths.ts";
import { fetchMirror } from "./repo.ts";
import { Runner } from "./runner.ts";
import { type Env, requiredIn, settings } from "./settings.ts";

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
    channels: CHANNELS.map((c) => c.create(env)),
    access: ACCESS.map((a) => a.create(env)),
    routerUrl: requiredIn(env, ENV.routerUrl),
    containerSecret: requiredIn(env, ENV.containerSecret),
    dataDir,
    repoUrl,
    env,
    maxRuns: Number(env.ACHQ_MAX_RUNS ?? DEFAULT_MAX_RUNS),
    runTimeoutMs: Number(env.ACHQ_RUN_TIMEOUT_MINUTES ?? DEFAULT_RUN_TIMEOUT_MINUTES) * 60_000,
    log: options.log,
    loadConfig: load,
  });
  return runner;
};

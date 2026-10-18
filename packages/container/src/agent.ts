import { ENV } from "@achq/core";
import { createGitHub } from "@achq/github/runtime";
import { createConfigLoader } from "./config/loader.ts";
import { DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES } from "./constants.ts";
import { paths as layout } from "./paths.ts";
import { fetchMirror, remoteHead } from "./repo.ts";
import { Runner } from "./runner.ts";
import { type Env, requiredIn, settings } from "./settings.ts";

/** The serving runner, wired from the container's environment. */
export const createAgent = (env: Env, options: { log?: (line: string) => void } = {}) => {
  const { repo, container, dataDir, repoUrl, bin } = settings(env);
  const paths = layout(dataDir);
  const { channel, access } = createGitHub({ baseUrl: env.GITHUB_API_URL || undefined });
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
    channels: [channel],
    providers: [access],
    routerUrl: requiredIn(env, ENV.routerUrl),
    containerSecret: requiredIn(env, ENV.containerSecret),
    dataDir,
    repoUrl,
    bin,
    env,
    maxRuns: Number(env.ACHQ_MAX_RUNS ?? DEFAULT_MAX_RUNS),
    runTimeoutMs: Number(env.ACHQ_RUN_TIMEOUT_MINUTES ?? DEFAULT_RUN_TIMEOUT_MINUTES) * 60_000,
    log: options.log,
    // Without a commit (a router that predates it), run the default branch's config.
    loadConfig: async (commit) => {
      if (commit) return load(commit);
      await fetchMirror(paths.mirror, repoUrl, await gitEnv());
      return load(await remoteHead(paths.mirror, await gitEnv()));
    },
  });
  return runner;
};

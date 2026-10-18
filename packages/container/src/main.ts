// achq-agent                          serve (the container's CMD)
// achq-agent sessions <n>             print thread <n>'s sessions as a JSON array
// achq-agent resume <n> [session]     open a session interactively, holding the thread's lock
import * as fs from "node:fs";
import { CONTAINER_PORT, ENV } from "@achq/core";
import { createGitHub } from "@achq/github/runtime";
import { formatSessions, resume, sessionsFor } from "./cli.ts";
import { createConfigLoader } from "./config.ts";
import { paths as layout } from "./paths.ts";
import { fetchMirror, remoteHead } from "./repo.ts";
import { Runner } from "./runner.ts";

type Env = Record<string, string | undefined>;

const requiredIn = (env: Env, name: string) => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const settings = (env: Env) => {
  const repo = requiredIn(env, ENV.repo);
  return {
    repo,
    container: requiredIn(env, ENV.container),
    dataDir: env.DATA_DIR ?? env.RAILWAY_VOLUME_MOUNT_PATH ?? "/data",
    repoUrl: env.ACHQ_REPO_URL ?? `https://github.com/${repo}.git`,
    bin: { claude: env.ACHQ_CLAUDE_BIN ?? "claude" },
  };
};

/** The serving runner, wired from the container's environment (what the deployer's `ContainerSpec.env` sets). */
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
    maxRuns: Number(env.ACHQ_MAX_RUNS ?? 2),
    runTimeoutMs: Number(env.ACHQ_RUN_TIMEOUT_MINUTES ?? 360) * 60_000,
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

const main = async () => {
  const { repo, container, dataDir, repoUrl, bin } = settings(process.env);
  const paths = layout(dataDir);
  const savedEnv = () => (fs.existsSync(paths.agentEnv) ? JSON.parse(fs.readFileSync(paths.agentEnv, "utf8")) : {});
  const [command, ...args] = process.argv.slice(2);
  const required1 = (arg: string | undefined) => {
    if (!arg) {
      console.error(`Usage: achq-agent ${command} <thread-number>${command === "resume" ? " [session]" : ""}`);
      process.exit(2);
    }
    return arg;
  };

  if (command === "sessions") {
    const sessions = sessionsFor(paths, required1(args[0]));
    console.log(formatSessions(sessions));
  } else if (command === "resume") {
    // Offline when the commit's already in the mirror; otherwise fetch with the last run's credentials.
    const loadConfig = createConfigLoader({
      mirror: paths.mirror,
      dir: (commit) => `${paths.config(commit)}-resume`,
      fetch: () => fetchMirror(paths.mirror, repoUrl, { ...process.env, ...savedEnv() }),
    });
    process.exit(await resume({ paths, number: required1(args[0]), session: args[1], loadConfig, container, bin }));
  } else if (command) {
    console.error(`Unknown command: ${command}`);
    process.exit(2);
  } else {
    process.env.HOME = paths.home;
    const runner = createAgent(process.env);
    await runner.reportInterrupted().catch((e) => console.error("reporting interrupted runs failed", e));
    const port = Number(process.env.PORT ?? CONTAINER_PORT);
    // Railway's private network is IPv6.
    Bun.serve({ port, hostname: "::", fetch: runner.fetch });
    console.log(`achq-agent for ${repo} (${container}), listening on :${port}`);
  }
};

if (import.meta.main) await main();

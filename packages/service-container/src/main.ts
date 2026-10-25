import { CONTAINER_PORT } from "@achq/core";
import { COMMANDS, RUNNER_BINARY, type RunnerCommand } from "@achq/core/commands";
import { Env } from "@achq/utils/env";
import { createAgent, settings } from "./agent.ts";
import { savedAgentEnv } from "./agent-env.ts";
import { createConfigLoader } from "./config.ts";
import { fetchMirror } from "./repo.ts";
import { resume } from "./resume.ts";
import { formatSessions, paths as layout, sessionsFor } from "./volume.ts";

const main = async () => {
  const { repo, container, dataDir, repoUrl } = settings(new Env(process.env));
  const paths = layout(dataDir);
  const [command, ...args] = process.argv.slice(2);
  const required = (arg: string | undefined) => {
    if (!arg) {
      console.error(`Usage: ${RUNNER_BINARY} ${COMMANDS.resume} <thread-number> <session-id>`);
      process.exit(2);
    }
    return arg;
  };

  // By the names commands.ts builds the CLI's argv with: one it adds is a type error here until it's handled.
  const commands: Record<RunnerCommand, () => Promise<void>> = {
    sessions: async () => {
      console.log(formatSessions(sessionsFor(paths, args[0])));
    },
    resume: async () => {
      // Offline when the commit's already in the mirror; otherwise fetch with the last run's credentials.
      const loadConfig = createConfigLoader({
        mirror: paths.mirror,
        dir: (commit) => `${paths.config(commit)}-resume`,
        fetch: () => fetchMirror(paths.mirror, repoUrl, { ...process.env, ...savedAgentEnv(paths.agentEnv) }),
      });
      process.exit(await resume({ paths, number: required(args[0]), session: required(args[1]), loadConfig, container }));
    },
  };
  const named = Object.entries(COMMANDS).find(([, name]) => name === command)?.[0] as RunnerCommand | undefined;

  if (named) {
    await commands[named]();
  } else if (command) {
    console.error(`Unknown command: ${command}`);
    process.exit(2);
  } else {
    // `serve()`: what the container provider starts it with.
    process.env.HOME = paths.home;
    const runner = createAgent(process.env);
    await runner.reportInterrupted().catch((e) => console.error("reporting interrupted runs failed", e));
    // "::" so private networks over IPv6 reach it.
    Bun.serve({ port: CONTAINER_PORT, hostname: "::", fetch: runner.fetch });
    console.log(`${RUNNER_BINARY} for ${repo} (${container}), listening on :${CONTAINER_PORT}`);
  }
};

if (import.meta.main) await main();

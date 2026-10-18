// achq-agent                          serve (the container's CMD)
// achq-agent sessions <n>             print thread <n>'s sessions as a JSON array
// achq-agent resume <n> [session]     open a session interactively, holding the thread's lock
import { CONTAINER_PORT } from "@achq/core";
import { createAgent } from "./agent.ts";
import { savedAgentEnv } from "./agent-env.ts";
import { createConfigLoader } from "./config/loader.ts";
import { paths as layout } from "./paths.ts";
import { fetchMirror } from "./repo.ts";
import { resume } from "./resume.ts";
import { formatSessions, sessionsFor } from "./sessions.ts";
import { settings } from "./settings.ts";

const main = async () => {
  const { repo, container, dataDir, repoUrl } = settings(process.env);
  const paths = layout(dataDir);
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
      fetch: () => fetchMirror(paths.mirror, repoUrl, { ...process.env, ...savedAgentEnv(paths.agentEnv) }),
    });
    process.exit(await resume({ paths, number: required1(args[0]), session: args[1], loadConfig, container }));
  } else if (command) {
    console.error(`Unknown command: ${command}`);
    process.exit(2);
  } else {
    process.env.HOME = paths.home;
    const runner = createAgent(process.env);
    await runner.reportInterrupted().catch((e) => console.error("reporting interrupted runs failed", e));
    const port = Number(process.env.PORT ?? CONTAINER_PORT);
    // "::" so private networks over IPv6 reach it.
    Bun.serve({ port, hostname: "::", fetch: runner.fetch });
    console.log(`achq-agent for ${repo} (${container}), listening on :${port}`);
  }
};

if (import.meta.main) await main();

import { COMMANDS, RUNNER_BINARY, type RunnerCommand } from "@achq/core/commands";
import { Env } from "@achq/utils/env";
import { resume, resumeConfig } from "./commands/resume.ts";
import { serve } from "./commands/serve.ts";
import { sessions } from "./commands/sessions.ts";
import { paths as layout } from "./features/layout.ts";
import { settings } from "./from-env.ts";

export const main = async () => {
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
    sessions: async () => sessions(paths, args[0]),
    resume: async () => {
      process.exit(await resume({ paths, number: required(args[0]), session: required(args[1]), loadConfig: resumeConfig(paths, repoUrl), container }));
    },
  };
  const named = Object.entries(COMMANDS).find(([, name]) => name === command)?.[0] as RunnerCommand | undefined;

  if (named) await commands[named]();
  else if (command) {
    console.error(`Unknown command: ${command}`);
    process.exit(2);
  } else await serve(process.env, paths, { repo, container });
};

if (import.meta.main) await main();

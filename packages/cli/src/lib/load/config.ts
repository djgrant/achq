import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { CLI_ENV, CONFIG_FILE } from "../../constants.ts";
import { callerCwd, repoRoot } from "../workdir.ts";

const Config = z.object({
  /** A command prefix that puts secrets in the environment, e.g. `op run --env-file=.env --`. achq runs itself under it. */
  env: z.string().optional(),
});

export type CliConfig = z.infer<typeof Config> & { dir: string };

/** The config at the root of `dir`'s repo, if there is one. */
export const loadConfig = async (dir = callerCwd()): Promise<CliConfig | undefined> => {
  const root = repoRoot(dir);
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return;
  const parsed = Config.safeParse((await import(file)).default);
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, dir: root };
};

/** Whether this process is already running under the config's `env` command. */
export const underEnv = () => process.env[CLI_ENV.underEnv] === "1";

/** Runs `argv` under the config's `env` command, from the config's directory so its relative paths hold. Resolves to its exit code. */
export const runUnderEnv = (config: CliConfig & { env: string }, argv: string[]) => {
  const proc = Bun.spawn(["sh", "-c", `${config.env} "$@"`, "achq", ...argv], {
    cwd: config.dir,
    env: { ...process.env, [CLI_ENV.underEnv]: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exited;
};

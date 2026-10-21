import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { CONFIG_FILE } from "../constants.ts";
import { callerCwd, repoRoot } from "./workdir.ts";

const Config = z.object({
  /** A command prefix that puts secrets in the environment, e.g. `op run --env-file=.env --`. achq takes on the environment it sets. */
  env: z.string().optional(),
});

export type CliConfig = z.infer<typeof Config> & { dir: string };

/** The config at the root of `dir`'s repo, if there is one. */
export const loadConfig = async (dir = callerCwd()) => {
  const root = repoRoot(dir);
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return;
  const parsed = Config.safeParse((await import(file)).default);
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, dir: root };
};

/**
 * The environment the config's `env` command gives what it runs, run from the config's directory so its relative paths hold.
 * achq takes it on rather than running itself under the command, which may pipe its output (as `op run` does to mask
 * secrets) and leave it without a terminal. What it runs writes the environment to a file, since its output may be masked.
 */
export const envFrom = async (config: CliConfig & { env: string }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achq-env-"));
  const file = path.join(dir, "env.json");
  try {
    const write = "await Bun.write(process.argv[1], JSON.stringify(process.env))";
    const proc = Bun.spawn(["sh", "-c", `${config.env} "$@"`, "achq", process.execPath, "-e", write, file], {
      cwd: config.dir,
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    if (code !== 0 || !fs.existsSync(file)) throw new Error(`\`${config.env}\` failed (exit ${code})`);
    return z.record(z.string(), z.string()).parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

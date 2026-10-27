import * as fs from "node:fs";
import * as path from "node:path";
import { defineEnvResolver } from "@pokit/core";
import { disk } from "@achq/utils/disk";
import type { Vault } from "@achq/core";
import { schema } from "@achq/utils/schema";
import * as v from "valibot";
import { callerCwd, repoRoot } from "../io/workdir.ts";

/** The CLI's own config, at the root of the repo it's run in. */
const CONFIG_FILE = "achq.config.ts";

const Config = v.object({
  /** A command prefix that puts secrets in the environment, e.g. `op run --env-file=.env --`. achq takes on the environment it sets. */
  env: v.optional(v.string()),
  /** Where `achq infra up` keeps GitHub Apps' private keys, to give them to another router, e.g. `onepassword.vault("achq")`: anything that reads and writes items. */
  vault: v.optional(v.custom<Vault>((x) => typeof (x as Vault | undefined)?.read === "function" && typeof (x as Vault).write === "function", "a vault, e.g. onepassword.vault(\"achq\")")),
});

export type CliConfig = v.InferOutput<typeof Config> & { dir: string };

/** The config at the root of `dir`'s repo, if there is one. */
export const loadConfig = async (dir = callerCwd()) => {
  const root = repoRoot(dir);
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return;
  const parsed = v.safeParse(Config, (await import(file)).default);
  if (!parsed.success) throw new Error(`${file}: ${schema.firstIssue(parsed.issues)}`);
  return { ...parsed.output, dir: root };
};

/**
 * The environment the config's `env` command gives what it runs, run from the config's directory so its relative paths hold.
 * achq takes it on rather than running itself under the command, which may pipe its output (as `op run` does to mask
 * secrets) and leave it without a terminal. What it runs writes the environment to a file, since its output may be masked.
 */
export const envFrom = (config: CliConfig & { env: string }) =>
  disk.withTempDir("achq-env-", async (dir) => {
    const file = path.join(dir, "env.json");
    const write = "await Bun.write(process.argv[1], JSON.stringify(process.env))";
    const proc = Bun.spawn(["sh", "-c", `${config.env} "$@"`, "achq", process.execPath, "-e", write, file], {
      cwd: config.dir,
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    if (code !== 0 || !fs.existsSync(file)) throw new Error(`\`${config.env}\` failed (exit ${code})`);
    return v.parse(v.record(v.string(), v.string()), JSON.parse(fs.readFileSync(file, "utf8")));
  });

/**
 * The config's `env` command as a resolver: the whole environment it sets, or nothing without one. It declares no
 * variables, as which a command needs depends on the infra's container provider and the agents', so `main.ts` takes
 * on all of it before any command's checks read the environment, rather than a task asking for named ones.
 */
export const configEnv = defineEnvResolver({
  availableVars: [] as string[],
  resolve: async () => {
    const config = await loadConfig();
    return config?.env ? envFrom({ ...config, env: config.env }) : {};
  },
});

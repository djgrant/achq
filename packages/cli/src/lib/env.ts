const OP_PREFIX = "op://";

/** Reads a value like op://vault/item/field from 1Password; other values are returned as they are. */
const resolve = (name: string, value: string) => {
  if (!value.startsWith(OP_PREFIX)) return value;
  const read = Bun.spawnSync(["op", "read", value], { stderr: "pipe" });
  if (read.exitCode !== 0) throw new Error(`Couldn't read ${name} from 1Password: ${read.stderr.toString().trim()}`);
  return read.stdout.toString().trim();
};

/** A secret from the environment. */
export const need = (name: string, hint = "") => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in the environment.${hint ? ` ${hint}` : ""}`);
  return resolve(name, value);
};

/** The environment, with 1Password references read as they're used. For platforms, which read their own settings. */
export const secretEnv = (): Record<string, string | undefined> =>
  new Proxy(process.env, { get: (env, name: string) => (env[name] ? resolve(name, env[name]) : undefined) });

import { type Env, requireEnv } from "@achq/utils/env";
import { run } from "@achq/utils/process";

const OP_PREFIX = "op://";

const isOpRef = (value: string) => value.startsWith(OP_PREFIX);

/** `name` is the variable it came from, for the error. */
const readOpRef = (name: string, ref: string) => {
  const read = run(["op", "read", ref]);
  if (!read.ok) throw new Error(`Couldn't read ${name} from 1Password: ${read.stderr.trim()}`);
  return read.stdout.trim();
};

const resolve = (name: string, value: string) => (isOpRef(value) ? readOpRef(name, value) : value);

export const need = (name: string, hint = "") => resolve(name, requireEnv(process.env, name, hint));

/** The environment, with 1Password references read as they're used. For the infra's resources, which read their own settings. */
export const secretEnv = (): Env => new Proxy(process.env, { get: (env, name: string) => (env[name] ? resolve(name, env[name]) : undefined) });

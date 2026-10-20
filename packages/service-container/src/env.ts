import { ENV } from "@achq/core";
import { PRIVATE_ENV } from "./constants.ts";

type Env = Record<string, string | undefined>;

/** achq's private variables, and the ones `env`'s ENV.privateEnv names (comma-separated). */
const privateNames = (env: Env) => {
  const named = (env[ENV.privateEnv] ?? "").split(",").map((name) => name.trim());
  return new Set([...PRIVATE_ENV, ...named.filter(Boolean)]);
};

/** `env` without achq's private variables, or the ones its ENV.privateEnv names. */
export const withoutPrivate = (env: Env): Record<string, string> => {
  const hidden = privateNames(env);
  const isShared = ([name, value]: [string, string | undefined]) => value !== undefined && !hidden.has(name);
  return Object.fromEntries(Object.entries(env).filter(isShared)) as Record<string, string>;
};

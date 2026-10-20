import { ENV } from "@achq/core";
import { PRIVATE_ENV } from "./constants.ts";

type Env = Record<string, string | undefined>;

const privateNames = (env: Env) => {
  const named = (env[ENV.privateEnv] ?? "").split(",").map((name) => name.trim());
  return new Set([...PRIVATE_ENV, ...named.filter(Boolean)]);
};

export const withoutPrivate = (env: Env): Record<string, string> => {
  const hidden = privateNames(env);
  const isShared = ([name, value]: [string, string | undefined]) => value !== undefined && !hidden.has(name);
  return Object.fromEntries(Object.entries(env).filter(isShared)) as Record<string, string>;
};

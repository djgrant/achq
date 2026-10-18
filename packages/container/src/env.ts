import { ENV } from "@achq/core";
import { PRIVATE_ENV } from "./constants.ts";

/** `env` without achq's private variables, or the ones its ENV.privateEnv names. */
export const withoutPrivate = (env: Record<string, string | undefined>): Record<string, string> => {
  const named = (env[ENV.privateEnv] ?? "").split(",").map((name) => name.trim());
  const hidden = new Set([...PRIVATE_ENV, ...named.filter(Boolean)]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !hidden.has(k)) out[k] = v;
  return out;
};

import { PRIVATE_ENV } from "./constants.ts";

export const withoutPrivate = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PRIVATE_ENV.includes(k)) out[k] = v;
  return out;
};

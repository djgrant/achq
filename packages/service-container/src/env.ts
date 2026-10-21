import { ENV } from "@achq/core";
import type { Vars } from "@achq/utils/env";
import { text } from "@achq/utils/text";
import { PRIVATE_ENV } from "./constants.ts";

const privateNames = (env: Vars) => new Set([...PRIVATE_ENV, ...text.commaList(env[ENV.privateEnv] ?? "")]);

export const withoutPrivate = (env: Vars): Record<string, string> => {
  const hidden = privateNames(env);
  const isShared = ([name, value]: [string, string | undefined]) => value !== undefined && !hidden.has(name);
  return Object.fromEntries(Object.entries(env).filter(isShared)) as Record<string, string>;
};

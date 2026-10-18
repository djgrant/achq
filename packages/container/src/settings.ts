import { ENV } from "@achq/core";
import { DEFAULT_DATA_DIR } from "./constants.ts";

export type Env = Record<string, string | undefined>;

export const requiredIn = (env: Env, name: string) => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

/** The settings every command needs, from the container's environment (what the deployer's `ContainerSpec.env` sets). */
export const settings = (env: Env) => {
  const repo = requiredIn(env, ENV.repo);
  return {
    repo,
    container: requiredIn(env, ENV.container),
    dataDir: env[ENV.dataDir] ?? DEFAULT_DATA_DIR,
    repoUrl: requiredIn(env, ENV.repoUrl),
  };
};

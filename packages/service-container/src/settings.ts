import { ENV } from "@achq/core";
import { type Env, requireEnv } from "@achq/utils/env";
import { DEFAULT_DATA_DIR } from "./constants.ts";

export type { Env };

/** The settings every command needs, from the container's environment (what the deployer's `ContainerSpec.env` sets). */
export const settings = (env: Env) => {
  const repo = requireEnv(env, ENV.repo);
  return {
    repo,
    container: requireEnv(env, ENV.container),
    dataDir: env[ENV.dataDir] ?? DEFAULT_DATA_DIR,
    repoUrl: requireEnv(env, ENV.repoUrl),
  };
};

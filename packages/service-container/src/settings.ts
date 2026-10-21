import { ENV } from "@achq/core";
import { Env, type Vars } from "@achq/utils/env";
import { DEFAULT_DATA_DIR } from "./constants.ts";

/** The settings every command needs, from the container's environment (what the deployer's `ContainerSpec.env` sets). */
export const settings = (vars: Vars) => {
  const env = new Env(vars);
  return {
    repo: env.require(ENV.repo),
    container: env.require(ENV.container),
    dataDir: env.optional(ENV.dataDir) ?? DEFAULT_DATA_DIR,
    repoUrl: env.require(ENV.repoUrl),
  };
};

import { join } from "node:path";
import { type ContainerProviderImplementation, ENV } from "@achq/core";
import { JsonDirStore } from "@achq/utils/disk";
import { Env } from "@achq/utils/env";
import { CONTAINER_PROVIDER, PRIVATE_ENV, RAILWAY_ENV } from "../lib/constants.ts";
import { tokenCheck } from "../lib/railway.ts";
import { RailwayContainerProvider, railwayShell } from "./provider.ts";

/** What the router and deployer keep is theirs alone: it holds every repo's config and deploy state. */
const PRIVATE_FILE_MODE = 0o600;

/**
 * Containers as services in the deployer's Railway project, reached in a shell
 * with `railway ssh`. The router and deployer keep what they store as files on
 * their volume, under DATA_DIR: a write is on the volume once it resolves.
 */
export const railwayContainerProvider: ContainerProviderImplementation = {
  id: CONTAINER_PROVIDER,
  create: (vars) => {
    const env = new Env(vars);
    return new RailwayContainerProvider({
      token: env.require(RAILWAY_ENV.token),
      projectId: env.require(RAILWAY_ENV.projectId),
      environmentId: env.require(RAILWAY_ENV.environmentId),
      endpoint: env.optional(RAILWAY_ENV.endpoint),
    });
  },
  privateEnv: PRIVATE_ENV,
  checks: (vars) => [tokenCheck(vars)],
  shell: railwayShell,
  store: (vars, collection) => new JsonDirStore(join(new Env(vars).require(ENV.dataDir), collection), { mode: PRIVATE_FILE_MODE }),
};

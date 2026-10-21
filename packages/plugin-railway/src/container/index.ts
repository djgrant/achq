import type { ContainerProvider, ContainerShell, Implementation } from "@achq/core";
import { Env } from "@achq/utils/env";
import { CONTAINER_PROVIDER, PRIVATE_ENV, RAILWAY_ENV } from "../lib/constants.ts";
import { tokenCheck } from "../lib/railway.ts";
import { RailwayContainerProvider, railwayShell } from "./provider.ts";

/** Containers as services in the deployer's Railway project, reached in a shell with `railway ssh`. */
export const railwayContainerProvider: Implementation<ContainerProvider> & { shell: ContainerShell } = {
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
};

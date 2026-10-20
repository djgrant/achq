import type { ContainerProvider, ContainerShell, Implementation } from "@achq/core";
import { optionalEnv, requireEnv } from "@achq/utils/env";
import { CONTAINER_PROVIDER, PRIVATE_ENV, RAILWAY_ENV } from "../lib/constants.ts";
import { RailwayContainerProvider, railwayShell } from "./provider.ts";

/** Containers as services in the deployer's Railway project, reached in a shell with `railway ssh`. */
export const railwayContainerProvider: Implementation<ContainerProvider> & { shell: ContainerShell } = {
  id: CONTAINER_PROVIDER,
  create: (env) =>
    new RailwayContainerProvider({
      token: requireEnv(env, RAILWAY_ENV.token),
      projectId: requireEnv(env, RAILWAY_ENV.projectId),
      environmentId: requireEnv(env, RAILWAY_ENV.environmentId),
      endpoint: optionalEnv(env, RAILWAY_ENV.endpoint),
    }),
  privateEnv: PRIVATE_ENV,
  shell: railwayShell,
};

import type { ContainerProvider, ContainerShell, Implementation } from "@achq/core";
import { need } from "../lib/client.ts";
import { CONTAINER_PROVIDER, PRIVATE_ENV, RAILWAY_ENV } from "../lib/constants.ts";
import { RailwayContainerProvider, railwayShell } from "./provider.ts";

/** Containers as services in the deployer's Railway project, reached in a shell with `railway ssh`. */
export const railwayContainerProvider: Implementation<ContainerProvider> & { shell: ContainerShell } = {
  id: CONTAINER_PROVIDER,
  create: (env) =>
    new RailwayContainerProvider({
      token: need(env, RAILWAY_ENV.token),
      projectId: need(env, RAILWAY_ENV.projectId),
      environmentId: need(env, RAILWAY_ENV.environmentId),
      endpoint: env[RAILWAY_ENV.endpoint] || undefined,
    }),
  privateEnv: PRIVATE_ENV,
  shell: railwayShell,
};

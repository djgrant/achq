import type { ContainerHost, ContainerShell, Implementation } from "@achq/core";
import { PLATFORM, RAILWAY_ENV } from "../lib/constants.ts";
import { need } from "../lib/env.ts";
import { PRIVATE_ENV } from "./constants.ts";
import { RailwayContainerHost } from "./container-host.ts";
import { railwayShell } from "./shell.ts";

/** Containers as services in the deployer's Railway project, reached in a shell with `railway ssh`. */
export const railwayContainerHost: Implementation<ContainerHost> & { shell: ContainerShell } = {
  id: PLATFORM,
  create: (env) =>
    new RailwayContainerHost({
      token: need(env, RAILWAY_ENV.token),
      projectId: need(env, RAILWAY_ENV.projectId),
      environmentId: need(env, RAILWAY_ENV.environmentId),
      endpoint: env[RAILWAY_ENV.endpoint] || undefined,
    }),
  privateEnv: PRIVATE_ENV,
  shell: railwayShell,
};

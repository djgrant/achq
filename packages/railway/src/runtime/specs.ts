import { CONTAINER_PORT, type ContainerSpec, ENV, type ServiceDefinition } from "@achq/core";
import { BRANCH, BUN_IMAGE, VOLUME } from "../constants.ts";
import { containerServiceName, hostServiceName } from "./names.ts";
import type { ServiceSpec } from "./plan.ts";
import { startCommand } from "./start-command.ts";

/** The router or the deployer: an image service on the stock Bun image, redeployed whenever its settings or variables change. */
export const achqServiceSpec = (service: ServiceDefinition): ServiceSpec => ({
  name: hostServiceName(service.name),
  settings: { source: { image: BUN_IMAGE }, startCommand: startCommand(service.entry), healthcheckPath: "/", sleepApplication: service.sleeps },
  variables: { ...service.env, [ENV.dataDir]: VOLUME, PORT: String(service.port) },
  volume: VOLUME,
  ...(service.public && { publicPort: service.port }),
  redeploy: true,
});

/** One Railway service per repo and container: private, sleeping when idle. The deployer starts their builds. */
export const containerServiceSpec = (spec: ContainerSpec): ServiceSpec => ({
  name: containerServiceName(spec.repo, spec.name),
  settings: {
    // Setting a Dockerfile path is what makes Railway build with Docker.
    dockerfilePath: spec.dockerfile,
    healthcheckPath: "/",
    // Sleeps when idle; the router wakes it over the private network.
    sleepApplication: true,
  },
  variables: {
    ...spec.env,
    [ENV.repo]: spec.repo,
    [ENV.container]: spec.name,
    [BRANCH]: spec.branch,
    [ENV.dataDir]: VOLUME,
    PORT: String(CONTAINER_PORT),
  },
  volume: VOLUME,
});

import { CONTAINER_PORT, type ContainerSpec, ENV } from "@achq/core";
import type { At } from "../resources/project.ts";
import { VOLUME } from "../lib/constants.ts";
import { containerServiceName } from "../lib/names.ts";
import { Service } from "../resources/service.ts";
import { Variables } from "../resources/variables.ts";
import { BRANCH } from "./constants.ts";

/**
 * One Railway service per repo and container: private, sleeping when idle,
 * and its variables. Not its deploy: the deployer starts its builds.
 */
export const containerService = (container: ContainerSpec, at: At) => {
  const name = containerServiceName(container.repo, container.name);
  const service = new Service(
    name,
    {
      at,
      name,
      settings: {
        // Setting a Dockerfile path is what makes Railway build with Docker.
        dockerfilePath: container.dockerfile,
        healthcheckPath: "/",
        // Sleeps when idle; the router wakes it over the private network.
        sleepApplication: true,
      },
      volume: VOLUME,
      // Once connected, Railway would deploy every push to the branch. The deployer starts builds itself.
      autoDeploy: false,
    },
    { declared: false },
  );
  const variables = new Variables(
    "variables",
    {
      at: { ...at, serviceId: service.out("serviceId") },
      service: name,
      values: {
        ...container.env,
        [ENV.repo]: container.repo,
        [ENV.container]: container.name,
        [BRANCH]: container.branch,
        [ENV.dataDir]: VOLUME,
        PORT: String(CONTAINER_PORT),
        // Railway sleeps a service 5–10 minutes after its last outbound packet, and private traffic counts.
        ...(container.env[ENV.routerUrl] && { [ENV.keepAwakeUrl]: `${container.env[ENV.routerUrl]}/` }),
      },
    },
    { parent: service },
  );
  return [service, variables];
};

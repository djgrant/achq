import { CONTAINER_PORT, type ContainerSpec, ENV } from "@achq/core";
import type { ProjectAt } from "@achq/utils/railway";
import { VOLUME } from "./constants.ts";
import { containerServiceName } from "./names.ts";
import { Service } from "./service.ts";
import { Variables } from "./variables.ts";

/**
 * One Railway service per repo and container: private, sleeping when idle,
 * and its variables. Not its build: `ensure` starts one when the deployer asks.
 */
export const containerParts = (container: ContainerSpec, at: ProjectAt) => {
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
        [ENV.dataDir]: VOLUME,
        PORT: String(CONTAINER_PORT),
        // Railway sleeps a service 5–10 minutes after its last outbound packet, and private traffic counts.
        [ENV.keepAwakeUrl]: `${container.env[ENV.routerUrl]}/`,
      },
    },
    { parent: service },
  );
  return { service, resources: [service, variables] };
};

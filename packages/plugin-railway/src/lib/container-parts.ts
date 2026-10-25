import { CONTAINER_PORT, type ContainerSpec, ENV } from "@achq/core";
import { serve } from "@achq/core/commands";
import type { ProjectAt } from "@achq/utils/railway";
import { VOLUME } from "./constants.ts";
import { containerServiceName } from "./names.ts";
import { Service } from "./service.ts";
import { Variables } from "./variables.ts";

/**
 * `argv` as one line, which Railway splits like a shell but expands no variables in: an argument with a space or a shell
 * operator is single-quoted, as `startCommand` quotes its script.
 */
export const commandLine = (argv: string[]) =>
  argv
    .map((arg) => {
      if (arg.includes("'")) throw new Error(`Railway's start command can't quote ${arg}`);
      return /[\s"$&|;<>()\\]/.test(arg) ? `'${arg}'` : arg;
    })
    .join(" ");

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
        // In place of the image's CMD, so the repo's Dockerfile doesn't name the runner.
        startCommand: commandLine(serve()),
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

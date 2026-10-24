import { achqStartScript, CONTAINER_PORT, type ContainerSpec, ENV, type EnvValues, type Input, type Output, type Placement, type Service as AchqService } from "@achq/core";
import type { InstanceSettings, ProjectAt } from "@achq/utils/railway";
import { BUN_IMAGE, VOLUME } from "./constants.ts";
import { Deployment, fingerprint } from "./deployment.ts";
import { containerServiceName, hostServiceName, privateUrl } from "./names.ts";
import { Service } from "./service.ts";
import { Variables } from "./variables.ts";

/**
 * Runs `entry` (e.g. `packages/service-router/src/main.ts`) from achq at
 * ACHQ_REF. The script must not contain single quotes, because Railway splits
 * the command like a shell.
 */
export const startCommand = (entry: string) => {
  // On the volume, which a wake keeps.
  return `bun -e '${achqStartScript(entry, { root: `(process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "/tmp") + "/achq"` })}'`;
};

/** Where one of achq's own services runs on Railway: its service, in `at`, and its deploy. */
export class ServiceParts implements Placement {
  readonly name: string;
  readonly dataDir = VOLUME;
  readonly service: Service;
  private readonly settings: InstanceSettings;
  private readonly at: { projectId: Input<string>; environmentId: Input<string>; serviceId: Input<string> };

  constructor(
    private readonly owner: AchqService,
    at: { projectId: Input<string>; environmentId: Input<string> },
    private readonly own: { wait: boolean },
  ) {
    this.name = hostServiceName(owner.name);
    // Its settings' key order is part of the deploy's fingerprint: reordering them redeploys.
    this.settings = { source: { image: BUN_IMAGE }, startCommand: startCommand(owner.entry), healthcheckPath: "/", sleepApplication: owner.sleeps };
    this.service = new Service(
      "service",
      { at, name: this.name, settings: this.settings, volume: VOLUME, ...(owner.public && { publicPort: owner.port }) },
      { parent: owner },
    );
    this.at = { ...at, serviceId: this.service.out("serviceId") };
  }

  privateUrl(port: number) {
    return privateUrl(this.name, port);
  }

  group(name: string, values: EnvValues) {
    return new Variables(name, { at: this.at, service: this.name, values }, { parent: this.owner });
  }

  resources(groups: Variables[], variables: Output<Record<string, string>>) {
    const deploy = new Deployment(
      "deploy",
      { at: this.at, service: this.name, fingerprint: variables.map((v) => fingerprint({ settings: this.settings, variables: v })), wait: this.own.wait },
      { parent: this.owner },
    );
    return [this.service, ...groups, deploy];
  }
}

/**
 * One Railway service per repo and container: private, sleeping when idle,
 * and its variables. Not its build: `ensure` starts one when the deployer asks.
 */
export const containerService = (container: ContainerSpec, at: ProjectAt) => {
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

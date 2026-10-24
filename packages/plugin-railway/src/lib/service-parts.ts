import { achqStartScript, CONTAINER_PORT, type ContainerSpec, type Context, ENV, type EnvValues, type Input, type ManagedResource, type Service as AchqService, type VariableValues, VariableGroups } from "@achq/core";
import type { InstanceSettings, ProjectAt } from "@achq/utils/railway";
import { BRANCH, BUN_IMAGE, VOLUME } from "./constants.ts";
import { Deployment, fingerprint } from "./deployment.ts";
import { containerServiceName, hostServiceName } from "./names.ts";
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

/** One of achq's own services as Railway resources: its service, its groups of variables, and its deploy. */
export class ServiceParts {
  readonly name: string;
  readonly service: Service;
  /** Its own variables, its first group: what every service has, and `own.variables`. */
  readonly first: Variables;
  private readonly settings: InstanceSettings;
  private readonly at: { projectId: Input<string>; environmentId: Input<string>; serviceId: Input<string> };
  private readonly groups: VariableGroups<Variables>;
  private made?: ManagedResource[];

  constructor(
    private readonly owner: AchqService,
    at: { projectId: Input<string>; environmentId: Input<string> },
    private readonly own: { variables?: (ctx: Context) => EnvValues; wait: boolean },
  ) {
    this.name = hostServiceName(owner.name);
    // Its settings' key order is part of the deploy's fingerprint: reordering them redeploys.
    this.settings = { source: { image: BUN_IMAGE }, startCommand: startCommand(owner.entry), healthcheckPath: "/", sleepApplication: owner.sleeps };
    this.service = new Service(
      "service",
      { at, name: this.name, settings: this.settings, volume: VOLUME, ...(owner.public && { publicPort: owner.port }), env: true },
      { parent: owner },
    );
    this.at = { ...at, serviceId: this.service.out("serviceId") };
    this.groups = new VariableGroups(this.name, (name, values) => new Variables(name, { at: this.at, service: this.name, values }, { parent: owner }));
    this.first = this.groups.add((ctx) => ({ ...own.variables?.(ctx), [ENV.dataDir]: VOLUME, PORT: String(owner.port) }));
  }

  variables(values: VariableValues) {
    return this.groups.add(values).outputs();
  }

  /** Made once, when it's planned: no group of variables can be declared after. */
  children(ctx: Context) {
    if (this.made) return this.made;
    // Over every group's variables as one map, as it hashed before variables came in groups.
    const { groups, variables } = this.groups.resolve(ctx);
    const deploy = new Deployment(
      "deploy",
      { at: this.at, service: this.name, fingerprint: variables.map((v) => fingerprint({ settings: this.settings, variables: v })), wait: this.own.wait },
      { parent: this.owner },
    );
    return (this.made = [this.service, ...groups, deploy]);
  }
}

/**
 * One Railway service per repo and container: private, sleeping when idle,
 * and its variables. Not its deploy: the deployer starts its builds.
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
        [BRANCH]: container.branch,
        [ENV.dataDir]: VOLUME,
        PORT: String(CONTAINER_PORT),
        // Railway sleeps a service 5–10 minutes after its last outbound packet, and private traffic counts.
        [ENV.keepAwakeUrl]: `${container.env[ENV.routerUrl]}/`,
      },
    },
    { parent: service },
  );
  return [service, variables];
};

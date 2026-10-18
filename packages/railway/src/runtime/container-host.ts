// Containers as Railway services: one per (repo, container), private, sleeping
// when idle, with a volume at /data. The deployer starts their builds; Railway
// doesn't deploy on pushes (automatic deploys are turned off once connected).
import { CONTAINER_PORT, ENV } from "@achq/core";
import type { ContainerHost, ContainerSpec, ServiceState } from "@achq/core";
import { type ProjectSnapshot, RAILWAY_API, RailwayClient } from "../api.ts";
import { type Change, planService, type ServiceSpec, serviceName } from "./service.ts";

/** The branch the service was last connected to, as `owner/repo@branch`. */
const CONNECTED = "ACHQ_CONNECTED";
const BRANCH = "ACHQ_BRANCH";

export const containerServiceName = (repo: string, name: string) => serviceName(repo.replace("/", "-"), name);

export const containerUrl = (service: string) => `http://${service}.railway.internal:${CONTAINER_PORT}`;

export type RailwayContainerHostOptions = {
  token: string;
  projectId: string;
  environmentId: string;
  /** Railway's GraphQL endpoint, for tests. */
  endpoint?: string;
};

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
    PORT: String(CONTAINER_PORT),
  },
  volume: "/data",
});

export class RailwayContainerHost implements ContainerHost {
  readonly platform = "railway";
  readonly railway: RailwayClient;

  constructor(readonly options: RailwayContainerHostOptions) {
    this.railway = new RailwayClient(options.token, options.endpoint ?? RAILWAY_API);
  }

  private target() {
    return { projectId: this.options.projectId, environmentId: this.options.environmentId };
  }

  private async snapshot(): Promise<ProjectSnapshot> {
    const project = await this.railway.project(this.options.projectId);
    return { ...project, environmentId: this.options.environmentId };
  }

  private async service(repo: string, name: string) {
    const service = containerServiceName(repo, name);
    const project = await this.snapshot();
    return { name: service, id: project.services.find((s) => s.name === service)?.id, project };
  }

  /** What `ensure` would change, without changing it. */
  async plan(spec: ContainerSpec): Promise<Change[]> {
    return (await this.planEnsure(spec)).changes;
  }

  private async planEnsure(spec: ContainerSpec) {
    const project = await this.snapshot();
    const plan = await planService(this.railway, this.target(), containerServiceSpec(spec), project);
    const { serviceId } = plan.current;
    // Once connected, Railway would deploy every push to the branch. achq starts builds itself.
    const autoDeploy = serviceId ? await this.railway.autoDeploy(this.options.projectId, this.options.environmentId, serviceId).catch(() => false) : false;
    const changes: Change[] = [...plan.changes];
    if (autoDeploy) changes.push({ op: "-", target: `${containerServiceName(spec.repo, spec.name)} automatic deploys` });
    return {
      changes,
      apply: async () => {
        const result = await plan.apply();
        if (autoDeploy) await this.railway.setAutoDeploy(this.options.projectId, this.options.environmentId, result.serviceId, false);
        return result;
      },
    };
  }

  async ensure(spec: ContainerSpec) {
    const service = containerServiceName(spec.repo, spec.name);
    await (await this.planEnsure(spec)).apply();
    return { url: containerUrl(service), service };
  }

  async deploy(repo: string, name: string) {
    const { id, name: service } = await this.service(repo, name);
    if (!id) throw new Error(`No Railway service ${service}; ensure it first`);
    const { projectId, environmentId } = this.target();
    const [instance, variables] = await Promise.all([this.railway.instance(environmentId, id), this.railway.variables(projectId, environmentId, id)]);
    const branch = variables[BRANCH];
    if (!branch) throw new Error(`${service} has no ${BRANCH}; ensure it first`);
    const connection = `${repo}@${branch}`;
    if (instance.source?.repo?.toLowerCase() === repo.toLowerCase() && variables[CONNECTED] === connection) {
      await this.railway.deployLatestCommit(environmentId, id);
      return;
    }
    // Connecting builds the branch's head. It also turns automatic deploys on, so they're turned off again.
    const before = instance.latestDeployment?.id;
    await this.railway.connect(id, repo, branch);
    await this.railway.setAutoDeploy(projectId, environmentId, id, false);
    await this.railway.setVariables(projectId, environmentId, id, { [CONNECTED]: connection });
    if ((await this.railway.instance(environmentId, id)).latestDeployment?.id === before) await this.railway.deployLatestCommit(environmentId, id);
  }

  async state(repo: string, name: string): Promise<ServiceState> {
    const { id } = await this.service(repo, name);
    if (!id) return "missing";
    return deploymentState((await this.railway.instance(this.options.environmentId, id)).latestDeployment?.status);
  }

  async list() {
    const project = await this.snapshot();
    const found = await Promise.all(
      project.services.map(async (s) => {
        const vars = await this.railway.variables(project.id, project.environmentId, s.id);
        return vars[ENV.repo] && vars[ENV.container] ? [{ repo: vars[ENV.repo], name: vars[ENV.container], service: s.name }] : [];
      }),
    );
    return found.flat();
  }

  async remove(repo: string, name: string) {
    const { id, project } = await this.service(repo, name);
    if (!id) return;
    // Deleting a service doesn't necessarily delete its volume.
    const volumes = project.volumes.filter((v) => v.serviceId === id);
    await this.railway.deleteService(id, this.options.environmentId);
    for (const v of volumes) await this.railway.deleteVolume(v.id);
  }

  async locate(repo: string, name: string) {
    return { platform: "railway", project: this.options.projectId, environment: this.options.environmentId, service: containerServiceName(repo, name) };
  }
}

/** Railway's deployment status, as a ServiceState. */
export const deploymentState = (status: string | undefined): ServiceState => {
  switch (status) {
    case undefined:
    case "REMOVED":
      return "missing";
    case "SUCCESS":
      return "running";
    case "SLEEPING":
      return "sleeping";
    case "FAILED":
    case "CRASHED":
      return "failed";
    default:
      // QUEUED, WAITING, INITIALIZING, BUILDING, DEPLOYING, REMOVING
      return "building";
  }
};

export const railwayContainerHost = (options: RailwayContainerHostOptions) => new RailwayContainerHost(options);

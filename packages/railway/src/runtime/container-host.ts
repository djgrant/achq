// The deployer starts containers' builds itself, so automatic deploys on push
// are turned off once a service is connected.
import { CONTAINER_PORT, ENV, type ContainerHost, type ContainerSpec, type ServiceState } from "@achq/core";
import { type Change, graph } from "@achq/reconcile";
import { type ProjectSnapshot, RailwayClient } from "../api.ts";
import { BRANCH, CONNECTED, RAILWAY_API } from "../constants.ts";
import { containerServiceName, containerUrl } from "./names.ts";
import { autoDeploy } from "./resources/auto-deploy.ts";
import { addService } from "./service-nodes.ts";

export type RailwayContainerHostOptions = {
  token: string;
  projectId: string;
  environmentId: string;
  /** Railway's GraphQL endpoint, for tests. */
  endpoint?: string;
};

export class RailwayContainerHost implements ContainerHost {
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

  /** One Railway service per repo and container: private, sleeping when idle (the router wakes it), with automatic deploys off. */
  private graph(spec: ContainerSpec) {
    const g = graph();
    const name = containerServiceName(spec.repo, spec.name);
    const place = g.derive(`railway project ${this.options.projectId}`, () => this.target());
    const added = addService(g, this.railway, {
      name,
      place,
      // Setting a Dockerfile path is what makes Railway build with Docker.
      settings: { dockerfilePath: spec.dockerfile, healthcheckPath: "/", sleepApplication: true },
      ports: [],
      variables: async () => ({ ...spec.env, [ENV.repo]: spec.repo, [ENV.container]: spec.name, [BRANCH]: spec.branch, PORT: String(CONTAINER_PORT) }),
    });
    g.add(`${name} automatic deploys`, autoDeploy(this.railway), async (o) => ({ ...(await added.on(o)), enabled: false }));
    return g;
  }

  /** What `ensure` would change, without changing it. */
  async plan(spec: ContainerSpec): Promise<Change[]> {
    return (await this.graph(spec).plan()).changes;
  }

  async ensure(spec: ContainerSpec) {
    const service = containerServiceName(spec.repo, spec.name);
    await this.graph(spec).apply();
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

// The deployer starts containers' builds itself, so automatic deploys on push
// are turned off once a service is connected. `ensure` reconciles the service
// and its variables; `deploy` builds, imperatively.
import { randomBytes } from "node:crypto";
import { type Change, type Context, type ContainerHost, type ContainerSpec, ENV, plan, type ServiceState } from "@achq/core";
import { type ProjectSnapshot, RailwayClient } from "../lib/client.ts";
import { CONTAINER_HOST, RAILWAY_API, RAILWAY_ENV } from "../lib/constants.ts";
import { containerServiceName, containerUrl } from "../lib/names.ts";
import { BRANCH, CONNECTED, SOURCE_HOST } from "./constants.ts";
import { containerService } from "./container-service.ts";

export type RailwayContainerHostOptions = {
  token: string;
  projectId: string;
  environmentId: string;
  /** Railway's GraphQL endpoint, for tests. */
  endpoint?: string;
};

export class RailwayContainerHost implements ContainerHost {
  readonly railway: RailwayClient;
  /** What its containers' resources are planned with. */
  private readonly ctx: Context;

  constructor(readonly options: RailwayContainerHostOptions) {
    const endpoint = options.endpoint ?? RAILWAY_API;
    this.railway = new RailwayClient(options.token, endpoint);
    this.ctx = {
      env: { [RAILWAY_ENV.token]: options.token, [RAILWAY_ENV.endpoint]: endpoint },
      log: () => {},
      newSecret: () => randomBytes(32).toString("hex"),
      sleep: (ms) => Bun.sleep(ms),
    };
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

  /** The container's service and variables. Not its deploy: `deploy` starts builds. */
  private resources(container: ContainerSpec) {
    return containerService(container, this.target());
  }

  /** What `ensure` would change, without changing it. */
  async plan(spec: ContainerSpec): Promise<Change[]> {
    return (await plan(this.resources(spec), this.ctx)).changes;
  }

  async ensure(spec: ContainerSpec) {
    if (spec.host !== SOURCE_HOST) throw new Error(`Railway builds containers from ${SOURCE_HOST} repos, not ${spec.host}`);
    const service = containerServiceName(spec.repo, spec.name);
    await (await plan(this.resources(spec), this.ctx)).apply();
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
    return { containerHost: CONTAINER_HOST, project: this.options.projectId, environment: this.options.environmentId, service: containerServiceName(repo, name) };
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

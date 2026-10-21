import { OPERATIONS, nodes, type RawProject } from "./operations.ts";
import { RailwayService } from "./service.ts";
import { RAILWAY_API, RailwayError, RailwayTransport } from "./transport.ts";
import type { AttachedVolume, ProjectAt, ProjectSnapshot, ProjectSummary, Workspace } from "./types.ts";

const PRODUCTION = "production";

const snapshotOf = (project: RawProject) => {
  const environments = nodes(project.environments);
  const environment = environments.find((e) => e.name === PRODUCTION) ?? environments[0];
  if (!environment) throw new RailwayError(`Railway project ${project.name} has no environment`);
  return {
    id: project.id,
    name: project.name,
    environmentId: environment.id,
    services: nodes(project.services),
    // Each volume once per service it's mounted on. A volume on no service isn't any service's.
    volumes: nodes(project.volumes).flatMap((volume) =>
      nodes(volume.volumeInstances).flatMap(({ serviceId, mountPath }) => (serviceId ? [{ id: volume.id, serviceId, mountPath }] : [])),
    ),
  };
};

export type FoundService = { service: RailwayService; volumes: AttachedVolume[] };

export class Railway {
  private readonly transport: RailwayTransport;

  constructor(token: string, endpoint = RAILWAY_API) {
    this.transport = new RailwayTransport(token, endpoint);
  }

  workspaces() {
    return this.transport.call(OPERATIONS.apiToken, {});
  }

  /** The projects in `workspaceId`, or that the token can see. */
  projects(workspaceId?: string) {
    return this.transport.call(OPERATIONS.projects, { workspaceId });
  }

  /** The project named `name`, if there's one. Several is an error: which one is meant can't be told. */
  async projectByName(name: string, workspaceId?: string) {
    const found = (await this.projects(workspaceId)).filter((p) => p.name === name);
    if (found.length > 1) throw new RailwayError(`Several Railway projects are named ${name}`);
    return found[0];
  }

  createProject(name: string, workspaceId: string) {
    return this.transport.call(OPERATIONS.projectCreate, { input: { name, workspaceId } });
  }

  async readProject(projectId: string) {
    return snapshotOf(await this.transport.call(OPERATIONS.project, { id: projectId }));
  }

  /** A project, working in one of its environments. Reads nothing. */
  project(at: ProjectAt) {
    return new RailwayProject(this.transport, at);
  }
}

export class RailwayProject {
  readonly id: string;
  readonly environmentId: string;

  constructor(
    private readonly transport: RailwayTransport,
    at: ProjectAt,
  ) {
    this.id = at.projectId;
    this.environmentId = at.environmentId;
  }

  /** Its services and volumes. Its `environmentId` is the project's default, not necessarily this one. */
  async snapshot() {
    return snapshotOf(await this.transport.call(OPERATIONS.project, { id: this.id }));
  }

  /** Reads nothing. */
  service(serviceId: string) {
    return new RailwayService(this.transport, { projectId: this.id, environmentId: this.environmentId, serviceId });
  }

  async serviceByName(name: string) {
    const { services, volumes } = await this.snapshot();
    const found = services.find((s) => s.name === name);
    if (!found) return undefined;
    return { service: this.service(found.id), volumes: volumes.filter((v) => v.serviceId === found.id) };
  }

  async createService(name: string) {
    const serviceId = await this.transport.call(OPERATIONS.serviceCreate, { input: { projectId: this.id, environmentId: this.environmentId, name } });
    return this.service(serviceId);
  }

  async deleteVolume(volumeId: string) {
    await this.transport.call(OPERATIONS.volumeDelete, { volumeId });
  }
}

// `achq/railway`: the ACHQ infra's Railway resources.
//
//   const router = new railway.Router("router", { project: "achq" });
//   const deployer = new railway.Deployer("deployer", { project: "achq", router, containerHost: railway.containerHost({ project: "achq" }), owners });
import * as core from "@achq/core";
import type { ContainerHost, ContainerSpec } from "@achq/core";
import { RailwayClient } from "./api.ts";
import { RailwayContainerHost } from "./runtime/container-host.ts";
import { RailwayDeployerHost, RailwayRouterHost } from "./runtime/hosts.ts";

export * from "./api.ts";
export * from "./runtime/container-host.ts";
export * from "./runtime/hosts.ts";
export * from "./runtime/service.ts";

/** The router, as a Railway service in `project`: public, always on, with a volume. */
export class Router extends core.Router {
  declare readonly inputs: { host: RailwayRouterHost };
  constructor(name: string, inputs: { project: string }) {
    super(name, { host: new RailwayRouterHost(inputs.project) });
  }
}

/** The deployer, as a Railway service in `project`: private, sleeping when idle. */
export class Deployer extends core.Deployer {
  declare readonly inputs: core.Deployer["inputs"] & { host: RailwayDeployerHost };
  constructor(name: string, inputs: { project: string; router: core.Router; containerHost: ContainerHost & { readonly platform: string }; owners: string[] }) {
    super(name, { router: inputs.router, host: new RailwayDeployerHost(inputs.project), containerHost: inputs.containerHost, owners: inputs.owners });
  }
}

/**
 * Containers as services in a Railway project, by name. In the infra this
 * says where the deployer puts containers; the deployer itself builds a
 * `railwayContainerHost` from its environment. Used directly, it finds the
 * project with RAILWAY_API_TOKEN.
 */
export class RailwayProjectContainerHost implements ContainerHost {
  readonly platform = "railway";
  private host?: Promise<RailwayContainerHost>;
  constructor(readonly project: string) {}

  private resolve() {
    this.host ??= (async () => {
      const token = process.env.RAILWAY_API_TOKEN;
      if (!token) throw new Error("Missing RAILWAY_API_TOKEN");
      const railway = new RailwayClient(token);
      const found = await railway.projectByName(this.project, process.env.RAILWAY_WORKSPACE_ID);
      if (!found) throw new Error(`No Railway project ${this.project}`);
      const project = await railway.project(found.id);
      return new RailwayContainerHost({ token, projectId: project.id, environmentId: project.environmentId });
    })();
    return this.host;
  }

  async ensure(spec: ContainerSpec) {
    return (await this.resolve()).ensure(spec);
  }
  async deploy(repo: string, name: string) {
    return (await this.resolve()).deploy(repo, name);
  }
  async state(repo: string, name: string) {
    return (await this.resolve()).state(repo, name);
  }
  async list() {
    return (await this.resolve()).list();
  }
  async remove(repo: string, name: string) {
    return (await this.resolve()).remove(repo, name);
  }
  async locate(repo: string, name: string) {
    return (await this.resolve()).locate(repo, name);
  }
}

export const containerHost = (options: { project: string }) => new RailwayProjectContainerHost(options.project);

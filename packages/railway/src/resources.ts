// The ACHQ infra's Railway resources.
//
//   const router = new railway.Router("router", { project: "achq" });
//   const deployer = new railway.Deployer("deployer", { project: "achq", router, containerHost: railway.containerHost({ project: "achq" }), owners });
import * as core from "@achq/core";
import type { ContainerHost } from "@achq/core";
import { RailwayProjectContainerHost } from "./runtime/container-host.ts";
import { RailwayDeployerHost, RailwayRouterHost } from "./runtime/hosts.ts";

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

export const containerHost = (options: { project: string }) => new RailwayProjectContainerHost(options.project);

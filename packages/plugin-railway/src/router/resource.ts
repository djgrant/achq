import * as core from "@achq/core";
import type { Output } from "@achq/core";
import { CONTAINER_PROVIDER } from "../lib/constants.ts";
import { Project } from "../lib/project.ts";
import { ServiceParts } from "../lib/service-parts.ts";
import { PLUGIN } from "../plugin.ts";

/**
 * The router, as a Railway service in `project`: public, always on, with a
 * volume. It owns the project, which its deployer and the containers share for
 * its private network. Applying waits for its deploy to go live.
 */
export class Router extends core.Router {
  readonly plugin = PLUGIN;
  readonly containerProvider = CONTAINER_PROVIDER;
  readonly project: Project;
  readonly url: Output<string>;
  protected readonly placement: ServiceParts;

  constructor(
    name: string,
    readonly inputs: { project: string },
  ) {
    super(name);
    this.project = new Project("project", { name: inputs.project }, { parent: this });
    this.placement = new ServiceParts(this, this.project.at(), { wait: true });
    this.url = this.placement.service.out("url").map((u) => u!);
  }

  children(ctx: core.Context) {
    return [this.project, ...super.children(ctx)];
  }
}

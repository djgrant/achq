import * as core from "@achq/core";
import type { Output } from "@achq/core";
import { Project } from "../lib/project.ts";
import { ServiceParts } from "../lib/service-parts.ts";
import { PLUGIN } from "../plugin.ts";
import { cloudflareContainerProvider } from "../container/index.ts";

/**
 * The router, as a Worker named after `project`, e.g. `achq-router`: public,
 * always on. It owns the project, whose namespace and bucket its deployer and
 * the containers share. It keeps its inbox, config and claims in its Durable
 * Object's storage, as the container provider's store does for achq's
 * services. Applying waits until it answers.
 */
export class Router extends core.Router {
  readonly plugin = PLUGIN;
  readonly provider = cloudflareContainerProvider;
  readonly project: Project;
  readonly url: Output<string>;
  protected readonly placement: ServiceParts;

  constructor(
    name: string,
    readonly inputs: { project: string },
  ) {
    super(name);
    this.project = new Project("project", { name: inputs.project }, { parent: this });
    this.placement = new ServiceParts(this, { name: inputs.project, resource: this.project }, { wait: true });
    this.url = this.placement.worker.out("url");
  }

  children(ctx: core.Context) {
    return [this.project, ...super.children(ctx)];
  }
}

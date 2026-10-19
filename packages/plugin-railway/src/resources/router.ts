import * as core from "@achq/core";
import { type Context, ENV, type EnvValues, GENERATED, type Output, type Resource } from "@achq/core";
import { PLATFORM } from "../lib/constants.ts";
import { hostServiceName, privateUrl } from "../lib/names.ts";
import { ServiceParts } from "./service-parts.ts";
import { Project } from "./project.ts";

/**
 * The router, as a Railway service in `project`: public, always on, with a
 * volume. It owns the project, which its deployer and the containers share for
 * its private network. Applying waits for its deploy to go live.
 */
export class Router extends core.Router {
  readonly platform = PLATFORM;
  readonly project: Project;
  readonly url: Output<string>;
  readonly key: Output<string>;
  readonly env: Output<Record<string, string>>;
  private readonly parts: ServiceParts;

  constructor(
    name: string,
    readonly inputs: { project: string },
  ) {
    super(name);
    this.project = new Project("project", { name: inputs.project }, { parent: this });
    this.parts = new ServiceParts(this, this.project.at(), { variables: () => ({ [ENV.key]: GENERATED }), wait: true });
    this.url = this.parts.service.out("url").map((u) => u!);
    this.key = this.parts.first.out(ENV.key);
    this.env = this.parts.service.out("env").map((env) => env!);
  }

  privateUrl(port: number) {
    return privateUrl(hostServiceName(this.name), port);
  }

  variables(values: EnvValues | ((ctx: Context) => EnvValues)) {
    return this.parts.variables(values);
  }

  children(ctx: Context): Resource[] {
    return [this.project, ...this.parts.children(ctx)];
  }
}

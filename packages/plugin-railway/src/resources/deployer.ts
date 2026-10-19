import * as core from "@achq/core";
import type { Context, EnvValues, Output, Resource } from "@achq/core";
import { PLATFORM, RAILWAY_ENV } from "../lib/constants.ts";
import { need } from "../lib/env.ts";
import { hostServiceName, privateUrl } from "../lib/names.ts";
import { ServiceParts } from "./service-parts.ts";
import type { Project } from "./project.ts";
import { Router } from "./router.ts";

/**
 * The deployer, as a Railway service in its router's project: private,
 * sleeping when idle. It deploys containers to the same project, so it has
 * what its container host needs: the token and the project.
 */
export class Deployer extends core.Deployer {
  readonly platform = PLATFORM;
  readonly project: Project;
  readonly env: Output<Record<string, string>>;
  private readonly parts: ServiceParts;

  constructor(
    name: string,
    readonly inputs: { router: core.Router; owners: string[] },
  ) {
    super(name);
    const { router } = inputs;
    if (!(router instanceof Router)) throw new Error(`railway.Deployer ${name} runs in its router's Railway project, so ${router.name} must be a railway.Router`);
    this.project = router.project;
    this.parts = new ServiceParts(this, this.project.at(), {
      variables: (ctx) => ({
        [RAILWAY_ENV.token]: need(ctx.env, RAILWAY_ENV.token),
        [RAILWAY_ENV.projectId]: this.project.out("projectId"),
        [RAILWAY_ENV.environmentId]: this.project.out("environmentId"),
      }),
      wait: false,
    });
    this.env = this.parts.service.out("env").map((env) => env!);
  }

  privateUrl(port: number) {
    return privateUrl(hostServiceName(this.name), port);
  }

  variables(values: EnvValues | ((ctx: Context) => EnvValues)) {
    return this.parts.variables(values);
  }

  children(ctx: Context): Resource[] {
    return this.parts.children(ctx);
  }
}

import * as core from "@achq/core";
import type { Context, EnvValues } from "@achq/core";
import { Env } from "@achq/utils/env";
import { RAILWAY_ENV } from "../lib/constants.ts";
import type { Project } from "../lib/project.ts";
import { ServiceParts } from "../lib/service-parts.ts";
import { Router } from "../router/resource.ts";
import { PLUGIN } from "../plugin.ts";
import { railwayContainerProvider } from "../container/index.ts";

/**
 * The deployer, as a Railway service in its router's project: private,
 * sleeping when idle. It deploys containers to the same project, so it has
 * what its container provider needs: the token and the project.
 */
export class Deployer extends core.Deployer {
  readonly plugin = PLUGIN;
  readonly provider = railwayContainerProvider;
  readonly project: Project;
  protected readonly placement: ServiceParts;

  constructor(
    name: string,
    readonly inputs: { router: core.Router; owners: string[] },
  ) {
    super(name);
    const { router } = inputs;
    if (!(router instanceof Router)) throw new Error(`railway.Deployer ${name} runs in its router's Railway project, so ${router.name} must be a railway.Router`);
    this.project = router.project;
    this.placement = new ServiceParts(this, this.project.at(), { wait: false });
  }

  /** What its container provider needs: the token and the project. */
  protected providerVariables(ctx: Context): EnvValues {
    return {
      [RAILWAY_ENV.token]: new Env(ctx.env).require(RAILWAY_ENV.token),
      [RAILWAY_ENV.projectId]: this.project.out("projectId"),
      [RAILWAY_ENV.environmentId]: this.project.out("environmentId"),
    };
  }
}

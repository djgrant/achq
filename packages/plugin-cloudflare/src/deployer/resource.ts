import * as core from "@achq/core";
import { type Context, Output } from "@achq/core";
import { CLOUDFLARE_ENV, CONTAINER_PROVIDER } from "../lib/constants.ts";
import { DeployerToken } from "../lib/deployer-token.ts";
import { ServiceParts } from "../lib/service-parts.ts";
import { Router } from "../router/resource.ts";

export type DeployerInputs = {
  router: core.Router;
  owners: string[];
  /**
   * Public keys (`ssh-ed25519 …` lines) written into each container Worker's
   * `authorized_keys`, which `wrangler containers ssh`, and so `achq container
   * ssh` and `resume`, connects with.
   */
  sshKeys?: string[];
};

/**
 * The deployer, as a Worker in its router's project: private, sleeping when
 * idle. It builds containers with Workers Builds, with a token of its own
 * that you make once, and Cloudflare's GitHub App on the repos it serves,
 * which only Cloudflare can tell is there: a repo it can't see fails its
 * deploy with the App's install page. It never gets your sign-in.
 */
export class Deployer extends core.Deployer {
  readonly containerProvider = CONTAINER_PROVIDER;
  readonly env: Output<Record<string, string>>;
  protected readonly placement: ServiceParts;
  private readonly token: DeployerToken;
  private rotating = false;

  constructor(
    name: string,
    readonly inputs: DeployerInputs,
  ) {
    super(name);
    const { router } = inputs;
    if (!(router instanceof Router)) throw new Error(`cloudflare.Deployer ${name} runs in its router's Cloudflare project, so ${router.name} must be a cloudflare.Router`);
    const project = router.project;
    const at = project.at();
    this.placement = new ServiceParts(this, { name: router.inputs.project, resource: project }, {
      variables: () => ({
        [CLOUDFLARE_ENV.accountId]: at.accountId,
        [CLOUDFLARE_ENV.project]: router.inputs.project,
        [CLOUDFLARE_ENV.namespace]: at.namespaceId,
        [CLOUDFLARE_ENV.bucket]: at.bucket,
        [CLOUDFLARE_ENV.workersDev]: at.workersDev,
        [CLOUDFLARE_ENV.sshKeys]: JSON.stringify(inputs.sshKeys ?? []),
      }),
      wait: false,
      // It starts with its token.
      deployAfter: () => [this.token],
    });
    this.env = this.placement.worker.out("env").map((env) => env!);
    this.token = new DeployerToken(
      "deployer-token",
      { worker: this.placement.name, tag: this.placement.worker.out("tag"), replace: new Output([], () => this.rotating) },
      // No sign-in can delete an API token.
      { parent: this, after: [this.placement.worker], protect: true },
    );
  }

  rotateToken() {
    this.rotating = true;
  }

  children(ctx: Context) {
    // Cloudflare's GitHub App isn't checked here: only Cloudflare can tell, so a deploy it can't build opens the App's page from `achq repo install`.
    return [this.token, ...super.children(ctx)];
  }
}

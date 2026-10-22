import * as core from "@achq/core";
import { type Context, type EnvValues, Output } from "@achq/core";
import { CLOUDFLARE_ENV, CONTAINER_PROVIDER } from "../lib/constants.ts";
import { DeployerToken } from "../lib/deployer-token.ts";
import { BuildsGitHubApp } from "../lib/github-app.ts";
import { privateUrl, serviceWorkerName } from "../lib/names.ts";
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
 * that you make once, and Cloudflare's GitHub App on every owner it serves.
 * It never gets your sign-in.
 */
export class Deployer extends core.Deployer {
  readonly containerProvider = CONTAINER_PROVIDER;
  readonly env: Output<Record<string, string>>;
  private readonly parts: ServiceParts;
  private readonly token: DeployerToken;
  private readonly apps: BuildsGitHubApp[];
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
    const worker = serviceWorkerName(router.inputs.project, name);
    this.parts = new ServiceParts(this, { name: router.inputs.project, resource: project }, {
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
    this.env = this.parts.worker.out("env").map((env) => env!);
    this.token = new DeployerToken(
      "deployer-token",
      { worker, tag: this.parts.worker.out("tag"), replace: new Output([], () => this.rotating) },
      { parent: this, after: [this.parts.worker] },
    );
    this.apps = inputs.owners.map((owner) => new BuildsGitHubApp(`github-app-${owner.toLowerCase()}`, { owner }, { parent: this }));
  }

  rotateToken() {
    this.rotating = true;
  }

  privateUrl(port: number) {
    const router = this.inputs.router as Router;
    return privateUrl(serviceWorkerName(router.inputs.project, this.name), port);
  }

  variables(values: EnvValues | ((ctx: Context) => EnvValues)) {
    return this.parts.variables(values);
  }

  children(ctx: Context) {
    return [...this.apps, this.token, ...this.parts.children(ctx)];
  }
}

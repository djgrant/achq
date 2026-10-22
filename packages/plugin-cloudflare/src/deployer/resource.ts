import * as core from "@achq/core";
import type { Context, EnvValues, Output } from "@achq/core";
import { Env } from "@achq/utils/env";
import { BuildToken } from "../lib/build-token.ts";
import { CLOUDFLARE_ENV, CONTAINER_PROVIDER } from "../lib/constants.ts";
import { BuildsGitHubApp } from "../lib/github-app.ts";
import { privateUrl, serviceWorkerName } from "../lib/names.ts";
import { ServiceParts } from "../lib/service-parts.ts";
import { Router } from "../router/resource.ts";

export type DeployerInputs = {
  router: core.Router;
  owners: string[];
  /** `ssh-ed25519` public keys `achq container ssh` connects to containers with, through `wrangler containers ssh`. */
  sshKeys?: string[];
};

/**
 * The deployer, as a Worker in its router's project: private, sleeping when
 * idle. It builds containers with Workers Builds, so it has your token, the
 * account's build token, and Cloudflare's GitHub App on every owner it serves.
 */
export class Deployer extends core.Deployer {
  readonly containerProvider = CONTAINER_PROVIDER;
  readonly env: Output<Record<string, string>>;
  private readonly parts: ServiceParts;
  private readonly buildToken: BuildToken;
  private readonly apps: BuildsGitHubApp[];

  constructor(
    name: string,
    readonly inputs: DeployerInputs,
  ) {
    super(name);
    const { router } = inputs;
    if (!(router instanceof Router)) throw new Error(`cloudflare.Deployer ${name} runs in its router's Cloudflare project, so ${router.name} must be a cloudflare.Router`);
    const project = router.project;
    const at = project.at();
    this.parts = new ServiceParts(this, { name: router.inputs.project, resource: project }, {
      variables: (ctx) => {
        const env = new Env(ctx.env);
        return {
          [CLOUDFLARE_ENV.token]: env.require(CLOUDFLARE_ENV.token),
          [CLOUDFLARE_ENV.accountId]: env.require(CLOUDFLARE_ENV.accountId),
          [CLOUDFLARE_ENV.project]: router.inputs.project,
          [CLOUDFLARE_ENV.namespace]: at.namespaceId,
          [CLOUDFLARE_ENV.bucket]: at.bucket,
          [CLOUDFLARE_ENV.workersDev]: at.workersDev,
          [CLOUDFLARE_ENV.sshKeys]: JSON.stringify(inputs.sshKeys ?? []),
        };
      },
      wait: false,
    });
    this.env = this.parts.worker.out("env").map((env) => env!);
    // Kept while the account lists it: the deployer's own variable says which it has.
    this.buildToken = new BuildToken("build-token", { stored: this.env.map((env) => env[CLOUDFLARE_ENV.buildToken]), worker: this.parts.name }, { parent: this, after: [this.parts.worker] });
    this.parts.variables({ [CLOUDFLARE_ENV.buildToken]: this.buildToken.out("uuid") });
    this.apps = inputs.owners.map((owner) => new BuildsGitHubApp(`github-app-${owner.toLowerCase()}`, { owner }, { parent: this }));
  }

  privateUrl(port: number) {
    const router = this.inputs.router as Router;
    return privateUrl(serviceWorkerName(router.inputs.project, this.name), port);
  }

  variables(values: EnvValues | ((ctx: Context) => EnvValues)) {
    return this.parts.variables(values);
  }

  children(ctx: Context) {
    return [...this.apps, this.buildToken, ...this.parts.children(ctx)];
  }
}

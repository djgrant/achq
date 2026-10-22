import { type ContainerProvider, type ContainerShell, ENV, type Implementation } from "@achq/core";
import { Env } from "@achq/utils/env";
import { CLOUDFLARE_ENV, CONTAINER_PROVIDER, PRIVATE_ENV } from "../lib/constants.ts";
import { tokenCheck } from "../lib/cloudflare.ts";
import { routerRepoIds } from "../lib/repo-ids.ts";
import { CloudflareContainerProvider, cloudflareShell } from "./provider.ts";

/** Containers as Workers on the deployer's account, each built from its repo by Workers Builds, reached in a shell with `wrangler containers ssh`. */
export const cloudflareContainerProvider: Implementation<ContainerProvider> & { shell: ContainerShell } = {
  id: CONTAINER_PROVIDER,
  create: (vars) => {
    const env = new Env(vars);
    const key = env.require(ENV.key);
    return new CloudflareContainerProvider({
      token: env.require(CLOUDFLARE_ENV.token),
      accountId: env.require(CLOUDFLARE_ENV.accountId),
      project: env.require(CLOUDFLARE_ENV.project),
      namespaceId: env.require(CLOUDFLARE_ENV.namespace),
      bucket: env.require(CLOUDFLARE_ENV.bucket),
      workersDev: env.require(CLOUDFLARE_ENV.workersDev),
      buildToken: env.require(CLOUDFLARE_ENV.buildToken),
      sshKeys: JSON.parse(env.optional(CLOUDFLARE_ENV.sshKeys) ?? "[]"),
      key,
      repoIds: routerRepoIds({ routerUrl: env.require(ENV.routerUrl), key, githubApi: env.optional("GITHUB_API_URL") }),
      endpoint: env.optional(CLOUDFLARE_ENV.endpoint),
    });
  },
  privateEnv: PRIVATE_ENV,
  checks: (vars) => [tokenCheck(vars)],
  shell: cloudflareShell,
};

import { INTERNAL_HOSTS } from "@achq/cloudflare-worker/settings";
import { type ContainerProviderImplementation, ENV } from "@achq/core";
import { Env } from "@achq/utils/env";
import { HttpJsonStore } from "@achq/utils/store";
import { CLOUDFLARE_ENV, CONTAINER_PROVIDER, PRIVATE_ENV } from "../lib/constants.ts";
import { tokenCheck } from "../lib/cloudflare.ts";
import { CloudflareContainerProvider } from "./provider.ts";

/**
 * Containers as Workers on the deployer's account, each built from its repo by
 * Workers Builds, reached in a shell with `wrangler containers ssh`. The router
 * and deployer keep what they store in their Durable Object's storage, which
 * keeps a write once it's answered, reached from their container at
 * `store.achq.internal`: their disk only outlives a stop in a snapshot.
 */
export const cloudflareContainerProvider: ContainerProviderImplementation = {
  id: CONTAINER_PROVIDER,
  create: (vars) => {
    const env = new Env(vars);
    return new CloudflareContainerProvider({
      // Its own, from its Worker's secret: never yours.
      token: env.require(CLOUDFLARE_ENV.deployerToken),
      accountId: env.require(CLOUDFLARE_ENV.accountId),
      project: env.require(CLOUDFLARE_ENV.project),
      namespaceId: env.require(CLOUDFLARE_ENV.namespace),
      bucket: env.require(CLOUDFLARE_ENV.bucket),
      workersDev: env.require(CLOUDFLARE_ENV.workersDev),
      sshKeys: JSON.parse(env.optional(CLOUDFLARE_ENV.sshKeys) ?? "[]"),
      key: env.require(ENV.key),
      endpoint: env.optional(CLOUDFLARE_ENV.endpoint),
    });
  },
  privateEnv: PRIVATE_ENV,
  checks: (vars) => [tokenCheck(vars)],
  store: (_vars, collection) => new HttpJsonStore(`http://${INTERNAL_HOSTS.store}/${collection}`),
};

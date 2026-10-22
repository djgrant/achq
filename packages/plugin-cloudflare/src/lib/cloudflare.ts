import type { Check } from "@achq/core";
import { implementationSecret } from "@achq/core/secrets";
import { CLOUDFLARE_API, Cloudflare, CloudflareError } from "@achq/utils/cloudflare";
import { Env, type Vars } from "@achq/utils/env";
import { CLOUDFLARE_ENV, CONTAINER_PROVIDER } from "./constants.ts";

const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
const TOKEN_HINT = `Create a user API token at ${TOKENS_PAGE}.`;
const ACTIVE = "active";

/** The account in `vars`, with its token, at CLOUDFLARE_API_URL if that's set (tests point it at a fake). */
export const cloudflareFromEnv = (vars: Vars) => {
  const env = new Env(vars);
  return new Cloudflare(env.require(CLOUDFLARE_ENV.token, TOKEN_HINT), env.require(CLOUDFLARE_ENV.accountId), env.optional(CLOUDFLARE_ENV.endpoint) ?? CLOUDFLARE_API);
};

/** That `vars` has a Cloudflare token and account, and Cloudflare takes the token. */
export const tokenCheck = (vars: Vars): Check => ({
  label: "Cloudflare token",
  check: async () => {
    // An answer from Cloudflare says it turned the token down; anything else, e.g. no network, says nothing about the token.
    const status = await cloudflareFromEnv(vars)
      .verifyToken()
      .catch((e) => {
        throw e instanceof CloudflareError ? new CloudflareError(`Cloudflare turned down ${CLOUDFLARE_ENV.token} (${e.message})`, e.status) : e;
      });
    if (status !== ACTIVE) throw new Error(`${CLOUDFLARE_ENV.token} is ${status} on Cloudflare`);
  },
  remediation: [
    `Set ${CLOUDFLARE_ENV.token} to a user token from ${TOKENS_PAGE} that can edit Workers Scripts, Workers KV Storage, Workers R2 Storage, Containers and Workers Builds Configuration`,
    `Set ${CLOUDFLARE_ENV.accountId} to the account's ID`,
  ],
});

/**
 * What achq's Workers prove themselves to each other with, from
 * AGENT_WEBHOOK_KEY: the CLI and the deployer each make it for the Workers
 * they deploy, and it never reaches a container.
 */
export const internalKey = (key: string) => implementationSecret(key, `${CONTAINER_PROVIDER}:internal`);

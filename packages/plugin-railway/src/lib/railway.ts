import type { Check } from "@achq/core";
import { Env, type Vars } from "@achq/utils/env";
import { RAILWAY_API, Railway, RailwayError, type ServiceAt } from "@achq/utils/railway";
import { RAILWAY_ENV } from "./constants.ts";

const TOKEN_HINT = "Create a token at https://railway.com/account/tokens.";

/** The account whose token is in `env`, at RAILWAY_API_URL if that's set (tests point it at a fake). */
export const railwayFromEnv = (vars: Vars) => {
  const env = new Env(vars);
  return new Railway(env.require(RAILWAY_ENV.token, TOKEN_HINT), env.optional(RAILWAY_ENV.endpoint) ?? RAILWAY_API);
};

/** That `vars` has a Railway token, and Railway takes it. */
export const tokenCheck = (vars: Vars) => ({
  label: "Railway token",
  check: async () => {
    // An answer from Railway says it turned the token down; anything else, e.g. no network, says nothing about the token.
    await railwayFromEnv(vars)
      .workspaces()
      .catch((e) => {
        throw e instanceof RailwayError ? new RailwayError(`Railway turned down ${RAILWAY_ENV.token} (${e.message})`) : e;
      });
  },
  remediation: [`Set ${RAILWAY_ENV.token} to a token from https://railway.com/account/tokens`],
}) satisfies Check;

/** Reads nothing. */
export const serviceAt = (env: Vars, at: ServiceAt) => railwayFromEnv(env).project(at).service(at.serviceId);

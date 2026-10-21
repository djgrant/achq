import { Env, type Vars } from "@achq/utils/env";
import { RAILWAY_API, Railway, type ServiceAt } from "@achq/utils/railway";
import { RAILWAY_ENV } from "./constants.ts";

const TOKEN_HINT = "Create a token at https://railway.com/account/tokens.";

/** The account whose token is in `env`, at RAILWAY_API_URL if that's set (tests point it at a fake). */
export const railwayFromEnv = (vars: Vars) => {
  const env = new Env(vars);
  return new Railway(env.require(RAILWAY_ENV.token, TOKEN_HINT), env.optional(RAILWAY_ENV.endpoint) ?? RAILWAY_API);
};

/** Reads nothing. */
export const serviceAt = (env: Vars, at: ServiceAt) => railwayFromEnv(env).project(at).service(at.serviceId);

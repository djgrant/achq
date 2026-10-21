import { Env, type Vars } from "@achq/utils/env";
import { RAILWAY_API, Railway, RailwayError, type RailwayService, type ServiceAt } from "@achq/utils/railway";
import { RAILWAY_ENV } from "./constants.ts";

const TOKEN_HINT = "Create a token at https://railway.com/account/tokens.";

/** The account whose token is in `env`, at RAILWAY_API_URL if that's set (tests point it at a fake). */
export const railwayFromEnv = (vars: Vars) => {
  const env = new Env(vars);
  return new Railway(env.require(RAILWAY_ENV.token, TOKEN_HINT), env.optional(RAILWAY_ENV.endpoint) ?? RAILWAY_API);
};

/** Reads nothing. */
export const serviceAt = (env: Vars, at: ServiceAt): RailwayService => railwayFromEnv(env).project(at).service(at.serviceId);

/** The workspace new projects go in: RAILWAY_WORKSPACE_ID, or else the token's only workspace. */
export const workspaceId = async (railway: Railway, env: Vars): Promise<string> => {
  const preferred = new Env(env).optional(RAILWAY_ENV.workspace);
  if (preferred) return preferred;
  const workspaces = await railway.workspaces();
  if (workspaces.length === 1) return workspaces[0]!.id;
  const list = workspaces.map((w) => `${w.name}: ${w.id}`).join(", ");
  throw new RailwayError(`Set ${RAILWAY_ENV.workspace} to one of your Railway workspaces: ${list}`);
};

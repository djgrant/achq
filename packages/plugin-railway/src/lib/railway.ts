// The Railway account achq works in: its token, and maybe its workspace and a
// fake API to point at, from the environment.
import { type Env, optionalEnv, requireEnv } from "@achq/utils/env";
import { RAILWAY_API, Railway, RailwayError, type RailwayService, type ServiceAt } from "@achq/utils/railway";
import { RAILWAY_ENV } from "./constants.ts";

const TOKEN_HINT = "Create a token at https://railway.com/account/tokens.";

/** The account whose token is in `env`, at RAILWAY_API_URL if that's set (tests point it at a fake). */
export const railwayFromEnv = (env: Env) =>
  new Railway(requireEnv(env, RAILWAY_ENV.token, TOKEN_HINT), optionalEnv(env, RAILWAY_ENV.endpoint) ?? RAILWAY_API);

/** Reads nothing. */
export const serviceAt = (env: Env, at: ServiceAt): RailwayService => railwayFromEnv(env).project(at).service(at.serviceId);

/** The workspace new projects go in: RAILWAY_WORKSPACE_ID, or else the token's only workspace. */
export const workspaceId = async (railway: Railway, env: Env): Promise<string> => {
  const preferred = optionalEnv(env, RAILWAY_ENV.workspace);
  if (preferred) return preferred;
  const workspaces = await railway.workspaces();
  if (workspaces.length === 1) return workspaces[0]!.id;
  const list = workspaces.map((w) => `${w.name}: ${w.id}`).join(", ");
  throw new RailwayError(`Set ${RAILWAY_ENV.workspace} to one of your Railway workspaces: ${list}`);
};

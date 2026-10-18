import type { Platform } from "@achq/core";
import { PLATFORM, PRIVATE_ENV, RAILWAY_ENV } from "../constants.ts";
import { Deployer, Router } from "../resources.ts";
import { railwayContainerHost } from "./container-host.ts";
import { railwayInfra } from "./infra.ts";
import { railwayShell } from "./shell.ts";

const need = (env: Record<string, string | undefined>, name: string, hint = "") => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name} in the environment.${hint ? ` ${hint}` : ""}`);
  return value;
};

export const railwayPlatform: Platform = {
  id: PLATFORM,

  infra({ router, deployer }, env) {
    if (!(router instanceof Router) || !(deployer instanceof Deployer)) throw new Error("Railway runs railway.Router and railway.Deployer");
    const project = router.inputs.project;
    if (deployer.inputs.project !== project) throw new Error(`The router and deployer must share one Railway project (${project}), for its private network`);
    return railwayInfra({ project, token: need(env, RAILWAY_ENV.token, "Create a token at https://railway.com/account/tokens."), workspaceId: env[RAILWAY_ENV.workspace] });
  },

  containerHost: (env) =>
    railwayContainerHost({ token: need(env, RAILWAY_ENV.token), projectId: need(env, RAILWAY_ENV.projectId), environmentId: need(env, RAILWAY_ENV.environmentId) }),

  shell: railwayShell,
  privateEnv: PRIVATE_ENV,
};

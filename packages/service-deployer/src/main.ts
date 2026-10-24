import { DEPLOYER_PORT, ENV } from "@achq/core";
import { Env } from "@achq/utils/env";
import { text } from "@achq/utils/text";
import { codeHostProviders, privateEnv, serviceContainerProvider } from "achq/registry";
import { createDeployer } from "./deployer.ts";
import { routerClient } from "./router-client.ts";
import { deployerHandler } from "./server.ts";

/** Bun's longest: a deploy that builds images can keep `/events` busy for minutes. */
const IDLE_TIMEOUT_S = 255;

export const main = () => {
  const env = new Env(process.env);
  const key = env.require(ENV.key);
  const routerUrl = env.require(ENV.routerUrl);
  const containerProvider = serviceContainerProvider(env);
  const deployer = createDeployer({
    containerProvider: containerProvider.provider.create(env.vars),
    router: routerClient({ url: routerUrl, key }),
    codeHostProviders: codeHostProviders(env.vars),
    owners: text.commaList(env.require(ENV.owners)),
    stores: containerProvider.stores,
    env: {
      containerEnv: JSON.parse(env.require(ENV.containerEnv)),
      privateEnv: privateEnv(),
      key,
      routerUrl,
      routerPublicUrl: env.require(ENV.routerPublicUrl),
      ref: env.require(ENV.ref),
    },
  });

  Bun.serve({ port: DEPLOYER_PORT, idleTimeout: IDLE_TIMEOUT_S, fetch: deployerHandler(deployer, key) });
  console.log(`deployer listening on ${DEPLOYER_PORT}`);
};

if (import.meta.main) main();

import { DEPLOYER_PORT, ENV } from "@achq/core";
import { optionalEnv, requireEnv } from "@achq/utils/env";
import { containerProviderNamed, privateEnv, CODE_HOST_PROVIDERS } from "achq/registry";
import { createDeployer } from "./deployer.ts";
import { DEFAULT_DATA_DIR } from "./constants.ts";
import { routerClient } from "./clients/router.ts";
import { deployerHandler } from "./server.ts";

/** Bun's longest: a deploy that builds images can keep `/sync` busy for minutes. */
const IDLE_TIMEOUT_S = 255;

/** A comma-separated list, trimmed, without empty items. */
const commaList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const main = () => {
  const env = process.env;
  const key = requireEnv(env, ENV.key);
  const routerUrl = requireEnv(env, ENV.routerUrl);
  const deployer = createDeployer({
    containerProvider: containerProviderNamed(requireEnv(env, ENV.containerProvider)).create(env),
    router: routerClient({ url: routerUrl, key }),
    codeHostProviders: Object.fromEntries(CODE_HOST_PROVIDERS.map((h) => [h.id, h.create(env)])),
    owners: commaList(requireEnv(env, ENV.owners)),
    dataDir: optionalEnv(env, ENV.dataDir) ?? DEFAULT_DATA_DIR,
    env: {
      containerEnv: JSON.parse(requireEnv(env, ENV.containerEnv)),
      privateEnv: privateEnv(),
      key,
      routerUrl,
      routerPublicUrl: requireEnv(env, ENV.routerPublicUrl),
      ref: requireEnv(env, ENV.ref),
    },
  });

  Bun.serve({ port: DEPLOYER_PORT, idleTimeout: IDLE_TIMEOUT_S, fetch: deployerHandler(deployer, key) });
  console.log(`deployer listening on ${DEPLOYER_PORT}`);
};

if (import.meta.main) main();

import { DEPLOYER_PORT, ENV } from "@achq/core";
import { containerProviderNamed, privateEnv, CODE_HOST_PROVIDERS } from "achq/registry";
import { createDeployer } from "./deployer.ts";
import { DEFAULT_DATA_DIR } from "./constants.ts";
import { routerClient } from "./clients/router.ts";
import { deployerHandler } from "./server.ts";

export const main = () => {
  const env = process.env;
  const need = (name: string) => env[name] || (console.error(`${name} is required`), process.exit(1));

  const key = need(ENV.key);
  const routerUrl = need(ENV.routerUrl);
  const containerProvider = containerProviderNamed(need(ENV.containerProvider)).create(env);
  const deployer = createDeployer({
    containerProvider,
    router: routerClient({ url: routerUrl, key }),
    codeHostProviders: Object.fromEntries(CODE_HOST_PROVIDERS.map((h) => [h.id, h.create(env)])),
    owners: need(ENV.owners).split(",").map((o) => o.trim()).filter(Boolean),
    dataDir: env[ENV.dataDir] || DEFAULT_DATA_DIR,
    env: {
      containerEnv: JSON.parse(need(ENV.containerEnv)),
      privateEnv: privateEnv(),
      key,
      routerUrl,
      routerPublicUrl: need(ENV.routerPublicUrl),
      ref: need(ENV.ref),
    },
  });

  Bun.serve({ port: DEPLOYER_PORT, idleTimeout: 255, fetch: deployerHandler(deployer, key) });
  console.log(`deployer listening on ${DEPLOYER_PORT}`);
};

if (import.meta.main) main();

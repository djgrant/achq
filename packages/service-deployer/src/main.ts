import { DEPLOYER_PORT, ENV } from "@achq/core";
import { containerHostNamed, privateEnv, REPO_HOSTS } from "achq/registry";
import { createDeployer } from "./deployer.ts";
import { DEFAULT_DATA_DIR } from "./constants.ts";
import { routerClient } from "./clients/router.ts";
import { deployerHandler } from "./server.ts";

export const main = () => {
  const env = process.env;
  const need = (name: string) => env[name] || (console.error(`${name} is required`), process.exit(1));

  const key = need(ENV.key);
  const routerUrl = need(ENV.routerUrl);
  const containerHost = containerHostNamed(need(ENV.containerHost)).create(env);
  const deployer = createDeployer({
    containerHost,
    router: routerClient({ url: routerUrl, key }),
    hosts: Object.fromEntries(REPO_HOSTS.map((h) => [h.id, h.create(env)])),
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

  const port = Number(env.DEPLOYER_PORT || DEPLOYER_PORT);
  Bun.serve({ port, idleTimeout: 255, fetch: deployerHandler(deployer, key) });
  console.log(`deployer listening on ${port}`);
};

if (import.meta.main) main();

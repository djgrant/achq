import { DEPLOYER_PORT, ENV } from "@achq/core";
import { ACCESS, containerHostNamed, privateEnv, REPO_HOSTS } from "achq/registry";
import { createDeployer } from "./deployer.ts";
import { DEFAULT_DATA_DIR, DEFAULT_REF } from "./constants.ts";
import { routerClient } from "./clients/router.ts";
import { deployerHandler } from "./server.ts";

export const main = () => {
  const env = process.env;
  const need = (name: string) => env[name] || (console.error(`${name} is required`), process.exit(1));

  const key = need(ENV.key);
  const routerUrl = need(ENV.routerUrl);
  const containerHost = containerHostNamed(need(ENV.platform)).create(env);
  const access = ACCESS.map((a) => a.create(env));
  const deployer = createDeployer({
    containerHost,
    router: routerClient({ url: routerUrl, key }),
    hosts: Object.fromEntries(REPO_HOSTS.map((h) => [h.id, h.create(env)])),
    policySource: (policy) => access.find((a) => a.id === policy.provider)?.policySource(policy),
    owners: need(ENV.owners).split(",").map((o) => o.trim()).filter(Boolean),
    dataDir: env[ENV.dataDir] || DEFAULT_DATA_DIR,
    env: {
      containerEnv: JSON.parse(need(ENV.containerEnv)),
      privateEnv: privateEnv(),
      key,
      routerUrl,
      routerPublicUrl: env[ENV.routerPublicUrl] || undefined,
      ref: env[ENV.ref] || DEFAULT_REF,
    },
  });

  const port = Number(env.DEPLOYER_PORT || DEPLOYER_PORT);
  Bun.serve({ port, idleTimeout: 255, fetch: deployerHandler(deployer, key) });
  console.log(`deployer listening on ${port}`);
};

if (import.meta.main) main();

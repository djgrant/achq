import { DEPLOYER_PORT, ENV } from "@achq/core";
import { createDeployer } from "./deployer.ts";
import { DEFAULT_DATA_DIR, DEFAULT_REF } from "./constants.ts";
import { routerClient } from "./clients/router.ts";
import { platformNamed } from "./platforms.ts";
import { deployerHandler } from "./server.ts";

export const main = () => {
  const env = process.env;
  const need = (name: string) => env[name] || (console.error(`${name} is required`), process.exit(1));

  const key = need(ENV.key);
  const routerUrl = need(ENV.routerUrl);
  const deployer = createDeployer({
    containerHost: platformNamed(need(ENV.platform)).containerHost(env),
    router: routerClient({ url: routerUrl, key }),
    owners: need(ENV.owners).split(",").map((o) => o.trim()).filter(Boolean),
    dataDir: env[ENV.dataDir] || DEFAULT_DATA_DIR,
    githubBaseUrl: env.GITHUB_API_URL || undefined,
    env: { claudeToken: need(ENV.claudeToken), key, routerUrl, routerPublicUrl: env[ENV.routerPublicUrl] || undefined, ref: env[ENV.ref] || DEFAULT_REF },
  });

  const port = Number(env.DEPLOYER_PORT || DEPLOYER_PORT);
  Bun.serve({ port, idleTimeout: 255, fetch: deployerHandler(deployer, key) });
  console.log(`deployer listening on ${port}`);
};

if (import.meta.main) main();

// The deployer service: `bun src/deployer/main.ts`.
import { DEPLOYER_PORT, ENV } from "@achq/core";
import { railwayContainerHost } from "@achq/railway";
import { createDeployer } from "./deployer.ts";
import { routerClient } from "./clients/router.ts";
import { deployerHandler } from "./server.ts";

export const main = () => {
  const env = process.env;
  const need = (name: string) => env[name] || (console.error(`${name} is required`), process.exit(1));

  const key = need(ENV.key);
  const routerUrl = need(ENV.routerUrl);
  const deployer = createDeployer({
    containerHost: railwayContainerHost({ token: need("RAILWAY_API_TOKEN"), projectId: need("ACHQ_RAILWAY_PROJECT_ID"), environmentId: need("ACHQ_RAILWAY_ENVIRONMENT_ID") }),
    router: routerClient({ url: routerUrl, key }),
    owners: need(ENV.owners).split(",").map((o) => o.trim()).filter(Boolean),
    dataDir: env.ACHQ_DATA_DIR || "/data",
    githubBaseUrl: env.GITHUB_API_URL || undefined,
    env: { claudeToken: need(ENV.claudeToken), key, routerUrl, routerPublicUrl: env[ENV.routerPublicUrl] || undefined, ref: env[ENV.ref] || "main" },
  });

  const port = Number(env.DEPLOYER_PORT || DEPLOYER_PORT);
  Bun.serve({ port, idleTimeout: 255, fetch: deployerHandler(deployer, key) });
  console.log(`deployer listening on ${port}`);
};

if (import.meta.main) main();

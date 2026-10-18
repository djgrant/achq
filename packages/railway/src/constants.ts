export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

/** The `Platform` id the infra's Railway resources name. */
export const PLATFORM = "railway";

/** Where the CLI and the deployer read their Railway settings from. */
export const RAILWAY_ENV = {
  token: "RAILWAY_API_TOKEN",
  workspace: "RAILWAY_WORKSPACE_ID",
  projectId: "ACHQ_RAILWAY_PROJECT_ID",
  environmentId: "ACHQ_RAILWAY_ENVIRONMENT_ID",
} as const;

/** How often `waitForDeploy` checks a deploy, and how many times: five minutes in all. */
export const DEPLOY_POLL_INTERVAL_MS = 5000;
export const DEPLOY_POLL_ATTEMPTS = 60;
/** The router and deployer run on the stock Bun image. */
export const BUN_IMAGE = "oven/bun:1-slim";

/** Where every service's volume is mounted. */
export const VOLUME = "/data";

/** Services reach each other at `<service>.<PRIVATE_DOMAIN>` over the project's private network. */
export const PRIVATE_DOMAIN = "railway.internal";

/** Railway service names double as hostnames, so they fit a DNS label. */
export const MAX_SERVICE_NAME = 63;

/** The router's and deployer's service names start with this. */
export const HOST_SERVICE_PREFIX = "achq";

/** A variable holding a hash of the settings and variables a service was last deployed with. */
export const DEPLOYED = "ACHQ_DEPLOYED";
/** The branch a container's service was last connected to, as `owner/repo@branch`. */
export const CONNECTED = "ACHQ_CONNECTED";
/** The branch a container's service builds from. */
export const BRANCH = "ACHQ_BRANCH";

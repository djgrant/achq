/** The container provider id: the router and deployer run on it, and the deployer puts containers on it. */
export const CONTAINER_PROVIDER = "railway";

/** Where the CLI and the deployer read their Railway settings from. */
export const RAILWAY_ENV = {
  token: "RAILWAY_API_TOKEN",
  /** Railway's GraphQL endpoint, if not the real one: tests point it at a fake. */
  endpoint: "RAILWAY_API_URL",
  workspace: "RAILWAY_WORKSPACE_ID",
  projectId: "ACHQ_RAILWAY_PROJECT_ID",
  environmentId: "ACHQ_RAILWAY_ENVIRONMENT_ID",
} as const;

/** What only the CLI and deployer have; the second is what Railway's own CLI reads. */
export const PRIVATE_ENV = [RAILWAY_ENV.token, "RAILWAY_TOKEN"];

export const VOLUME = "/data";

/** Services reach each other at `<service>.<PRIVATE_DOMAIN>` over the project's private network. */
export const PRIVATE_DOMAIN = "railway.internal";

/** Railway service names double as hostnames, so they fit a DNS label. */
export const MAX_SERVICE_NAME = 63;

export const HOST_SERVICE_PREFIX = "achq";

export const BUN_IMAGE = "oven/bun:1-slim";

/** A variable holding a hash of the settings and variables a service was last deployed with. */
export const DEPLOYED = "ACHQ_DEPLOYED";

/** How often the router's deploy is checked while waiting for it to go live, and how long to wait in all. */
export const DEPLOY_POLL_INTERVAL_MS = 5000;
export const DEPLOY_TIMEOUT_MS = 5 * 60_000;

/** Railway builds a container's service from its repo through its GitHub integration. */
export const SOURCE_HOST = "github";

/** The branch a container's service was last connected to, as `owner/repo@branch`. */
export const CONNECTED = "ACHQ_CONNECTED";
export const BRANCH = "ACHQ_BRANCH";

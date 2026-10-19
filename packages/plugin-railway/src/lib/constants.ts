export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

/** The container host id: the router and deployer run on it, and the deployer puts containers on it. */
export const CONTAINER_HOST = "railway";

/** Where the CLI and the deployer read their Railway settings from. */
export const RAILWAY_ENV = {
  token: "RAILWAY_API_TOKEN",
  /** Railway's GraphQL endpoint, if not RAILWAY_API: tests point it at a fake. */
  endpoint: "RAILWAY_API_URL",
  workspace: "RAILWAY_WORKSPACE_ID",
  projectId: "ACHQ_RAILWAY_PROJECT_ID",
  environmentId: "ACHQ_RAILWAY_ENVIRONMENT_ID",
} as const;

/** Where every service's volume is mounted. */
export const VOLUME = "/data";

/** Services reach each other at `<service>.<PRIVATE_DOMAIN>` over the project's private network. */
export const PRIVATE_DOMAIN = "railway.internal";

/** Railway service names double as hostnames, so they fit a DNS label. */
export const MAX_SERVICE_NAME = 63;

/** The router's and deployer's service names start with this. */
export const HOST_SERVICE_PREFIX = "achq";

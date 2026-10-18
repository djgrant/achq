/** The router's public port: webhooks, `/wake`, signed admin requests. */
export const ROUTER_PUBLIC_PORT = 8080;
/** The router's private port. It has no public domain. Serves credentials and claims to containers, and admin to the deployer. */
export const ROUTER_PRIVATE_PORT = 8081;
export const DEPLOYER_PORT = 3000;
export const CONTAINER_PORT = 3000;

export const ENV = {
  /** Root of every derived secret. Router and deployer. */
  key: "AGENT_WEBHOOK_KEY",
  /** The router's private base URL. Deployer and containers. */
  routerUrl: "ACHQ_ROUTER_URL",
  /** The router's public base URL. The deployer puts it in ACHQ_STATUS so the repo CLI can call `/wake`. */
  routerPublicUrl: "ACHQ_ROUTER_PUBLIC_URL",
  privatePort: "PRIVATE_PORT",
  /** The deployer's private base URL. Router. */
  deployerUrl: "ACHQ_DEPLOYER_URL",
  /** `{ [slug]: { id, privateKey } }` as JSON. Router only. */
  githubApps: "ACHQ_GITHUB_APPS",
  /** Repo owners the deployer serves, comma-separated. */
  owners: "ACHQ_OWNERS",
  repo: "ACHQ_REPO",
  container: "ACHQ_CONTAINER",
  containerSecret: "ACHQ_CONTAINER_SECRET",
  claudeToken: "CLAUDE_CODE_OAUTH_TOKEN",
  /** The achq commit a container or service runs. */
  ref: "ACHQ_REF",
  /** Where a service's or container's volume is. Each platform sets it. */
  dataDir: "DATA_DIR",
  /** The `Platform` the deployer puts containers on. */
  platform: "ACHQ_PLATFORM",
} as const;

/** Where achq's own code is, as `owner/repo` on GitHub. The router and deployer run it from there. */
export const ACHQ_SOURCE = "djgrant/achq";

/** The repository variable the deployer reports each deploy's outcome in. */
export const STATUS_VARIABLE = "ACHQ_STATUS";

/** Resource names: lowercase letters, digits and dashes, starting with a letter. */
export const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

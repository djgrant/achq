/** Ports and environment variable names shared by achq's services. */

/** The router's public port: webhooks, `/wake`, signed admin requests. */
export const ROUTER_PUBLIC_PORT = 8080;
/** The router's private port, with no public domain: credentials and claims for containers, admin for the deployer. */
export const ROUTER_PRIVATE_PORT = 8081;
export const DEPLOYER_PORT = 3000;
export const CONTAINER_PORT = 3000;

export const ENV = {
  /** Root of every derived secret. Router and deployer. */
  key: "AGENT_WEBHOOK_KEY",
  /** The router's private base URL. Deployer and containers. */
  routerUrl: "ACHQ_ROUTER_URL",
  /** The router's public base URL, which the deployer puts in ACHQ_STATUS for the repo CLI's `/wake`. */
  routerPublicUrl: "ACHQ_ROUTER_PUBLIC_URL",
  /** The router's private port. */
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
} as const;

/** The repository variable the deployer reports each deploy's outcome in. */
export const STATUS_VARIABLE = "ACHQ_STATUS";

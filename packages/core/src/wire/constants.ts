/** The router's public port: webhooks, `/wake`, signed admin requests. */
export const ROUTER_PUBLIC_PORT = 8080;
/** Only achq's own services reach it, never the public. Serves credentials to containers, and admin to the deployer. */
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
  /** The deployer's private base URL. Router. */
  deployerUrl: "ACHQ_DEPLOYER_URL",
  /** Repo owners the deployer serves, comma-separated. */
  owners: "ACHQ_OWNERS",
  repo: "ACHQ_REPO",
  container: "ACHQ_CONTAINER",
  containerSecret: "ACHQ_CONTAINER_SECRET",
  /** Where the container clones its repo from: `CodeHostProvider.cloneUrl`. */
  repoUrl: "ACHQ_REPO_URL",
  /** What the deployer gives every container, as JSON: the agent runtimes' variables. */
  containerEnv: "ACHQ_CONTAINER_ENV",
  /** A URL a container fetches every few minutes while it's working, on container providers that sleep idle services. */
  keepAwakeUrl: "ACHQ_KEEP_AWAKE_URL",
  /** The achq commit a container or service runs. */
  ref: "ACHQ_REF",
  /** Where a service or container keeps what outlives a restart. Its container provider sets it. */
  dataDir: "DATA_DIR",
  /** How many runs a container has going at once. Optional. */
  maxRuns: "ACHQ_MAX_RUNS",
  /** How long a container's run may take before it's stopped, in minutes. Optional. */
  runTimeoutMinutes: "ACHQ_RUN_TIMEOUT_MINUTES",
  /** The container provider the router and deployer run on, by id: where they keep what they store, and where the deployer puts containers. */
  containerProvider: "ACHQ_CONTAINER_PROVIDER",
} as const;


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
  /** Repo owners the deployer serves, comma-separated. */
  owners: "ACHQ_OWNERS",
  repo: "ACHQ_REPO",
  container: "ACHQ_CONTAINER",
  containerSecret: "ACHQ_CONTAINER_SECRET",
  /** Where the container clones its repo from: `RepoHost.cloneUrl`. */
  repoUrl: "ACHQ_REPO_URL",
  /** What the deployer gives every container, as JSON: the agent runtimes' variables. */
  containerEnv: "ACHQ_CONTAINER_ENV",
  /** Comma-separated: variables a container never hands to an agent, from the platform and providers. */
  privateEnv: "ACHQ_PRIVATE_ENV",
  /** A URL a container fetches every few minutes while it's working, on platforms that sleep idle services. */
  keepAwakeUrl: "ACHQ_KEEP_AWAKE_URL",
  /** The achq commit a container or service runs. */
  ref: "ACHQ_REF",
  /** Where a service's or container's volume is. Each platform sets it. */
  dataDir: "DATA_DIR",
  /** The `Platform` the deployer puts containers on. */
  platform: "ACHQ_PLATFORM",
} as const;

/** Where achq's own code is. The router and deployer run it from there. */
export const ACHQ_SOURCE = {
  /** The `Provider` hosting it. */
  host: "github",
  repo: "djgrant/achq",
  branch: "main",
  /** A tarball of it, followed by a commit. */
  archive: "https://codeload.github.com/djgrant/achq/tar.gz/",
};

/** The repository variable the deployer reports each deploy's outcome in. */
export const STATUS_VARIABLE = "ACHQ_STATUS";

/** Resource names: lowercase letters, digits and dashes, starting with a letter. */
export const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

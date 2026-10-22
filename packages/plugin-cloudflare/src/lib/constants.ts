/** The container provider id: the router and deployer run on it, and the deployer puts containers on it. */
export const CONTAINER_PROVIDER = "cloudflare";

/** Where the CLI and the deployer read their Cloudflare settings from. */
export const CLOUDFLARE_ENV = {
  /** A user API token: Workers Builds' API takes no other. Wrangler reads it too. */
  token: "CLOUDFLARE_API_TOKEN",
  accountId: "CLOUDFLARE_ACCOUNT_ID",
  /** Cloudflare's API, if not the real one: tests point it at a fake. */
  endpoint: "CLOUDFLARE_API_URL",
  /** The command that deploys the router and deployer, if not `npx -y wrangler@4`: tests point it at a fake. */
  wrangler: "ACHQ_CLOUDFLARE_WRANGLER",
  // ── The deployer's, set by `achq infra up` ──
  /** The infra's project: what its Workers are named after, and its KV namespace and R2 bucket. */
  project: "ACHQ_CLOUDFLARE_PROJECT",
  namespace: "ACHQ_CLOUDFLARE_NAMESPACE",
  bucket: "ACHQ_CLOUDFLARE_BUCKET",
  /** The account's `<subdomain>.workers.dev`. */
  workersDev: "ACHQ_CLOUDFLARE_WORKERS_DEV",
  /** The Workers Builds token containers are built with. */
  buildToken: "ACHQ_CLOUDFLARE_BUILD_TOKEN",
  /** Public keys `wrangler containers ssh` connects with, as JSON. */
  sshKeys: "ACHQ_CLOUDFLARE_SSH_KEYS",
} as const;

/** What only the CLI and deployer have. */
export const PRIVATE_ENV = [CLOUDFLARE_ENV.token];

/** Workers' names double as hostnames, so they fit a DNS label. */
export const MAX_WORKER_NAME = 63;

export const WRANGLER = ["npx", "-y", "wrangler@4"];

/** Bun, as the router and deployer get it on their first start: Cloudflare's image has only Node. */
export const BUN_VERSION = "1.3.14";

/** Every container: `lite` is too small for a 2 GB image. */
export const INSTANCE = "standard-1";

/** A variable holding a hash of what a Worker was last deployed with. */
export const DEPLOYED = "deployed";

/** How often a deploy is checked on, and how long it can take: Builds take 1.5 to 3 minutes, with no layer cache. */
export const BUILD_POLL_INTERVAL_MS = 10_000;
export const BUILD_TIMEOUT_MS = 30 * 60_000;
/** How often the router is checked while waiting for it to answer after a deploy, and how long to wait in all: its first start installs Bun and achq. */
export const ANSWER_POLL_INTERVAL_MS = 5000;
export const ANSWER_TIMEOUT_MS = 5 * 60_000;
/** How much of a failed build's log its error quotes. */
export const LOG_TAIL_LINES = 30;

/** Workers Builds builds containers from their repos through its GitHub App. */
export const SOURCE_HOST = "github";
/** Cloudflare's GitHub App, which Workers Builds clones repos with. */
export const BUILDS_GITHUB_APP = "cloudflare-workers-and-pages";

/** How often a browser flow checks whether it's done, and how long it waits for you. */
export const FLOW_POLL_INTERVAL_MS = 5000;
export const FLOW_TIMEOUT_MS = 15 * 60_000;

/** The container provider id: the router and deployer run on it, and the deployer puts containers on it. */
export const CONTAINER_PROVIDER = "cloudflare";

import { time } from "@achq/utils/time";
import { DEPLOYER_TOKEN } from "../../worker/settings.ts";

/** Where the CLI and the deployer read their Cloudflare settings from. */
export const CLOUDFLARE_ENV = {
  /** An API token, e.g. in CI. Without one, the CLI uses Wrangler's OAuth sign-in. Wrangler reads it too. */
  token: "CLOUDFLARE_API_TOKEN",
  /** Without one, the only account the CLI's sign-in reaches. */
  accountId: "CLOUDFLARE_ACCOUNT_ID",
  /** Cloudflare's API, if not the real one: tests point it at a fake. */
  endpoint: "CLOUDFLARE_API_URL",
  /** The command that runs Wrangler, for its sign-in and to deploy the router and deployer, if not `npx -y wrangler@4`: tests point it at a fake. */
  wrangler: "ACHQ_CLOUDFLARE_WRANGLER",
  // ── The deployer's, set by `achq infra up` ──
  /** The infra's project: what its Workers are named after, and its KV namespace and R2 bucket. */
  project: "ACHQ_CLOUDFLARE_PROJECT",
  namespace: "ACHQ_CLOUDFLARE_NAMESPACE",
  bucket: "ACHQ_CLOUDFLARE_BUCKET",
  /** The account's `<subdomain>.workers.dev`. */
  workersDev: "ACHQ_CLOUDFLARE_WORKERS_DEV",
  /** The deployer's own API token, which `achq infra up` has you create: only ever its Worker's secret. */
  deployerToken: DEPLOYER_TOKEN,
  /** Public keys `wrangler containers ssh` connects with, as JSON. */
  sshKeys: "ACHQ_CLOUDFLARE_SSH_KEYS",
} as const;

/** What only the CLI and deployer have. */
export const PRIVATE_ENV = [CLOUDFLARE_ENV.token, CLOUDFLARE_ENV.deployerToken];

/**
 * What the deployer's token can do, by Cloudflare's permission group keys, as
 * the dashboard's create-token page takes them: Workers Scripts, KV, R2,
 * Containers (and Cloudchamber, which they run on) and Workers Builds (`workers_ci`)
 * to edit, and the account's settings to read.
 */
export const DEPLOYER_TOKEN_PERMISSIONS = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_kv_storage", type: "edit" },
  { key: "workers_r2", type: "edit" },
  { key: "containers", type: "edit" },
  { key: "cloudchamber", type: "edit" },
  { key: "workers_ci", type: "edit" },
  { key: "account_settings", type: "read" },
];

/** What the deployer's token is named, in the dashboard and as Workers Builds' token. */
export const DEPLOYER_TOKEN_NAME = "achq-deployer";

/** How many times a pasted token that doesn't work is asked for again. */
export const TOKEN_ATTEMPTS = 3;

/** How long Wrangler's OAuth token is used before asking Wrangler again, which refreshes it: it lasts an hour. */
export const WRANGLER_TOKEN_REUSE_MS = 5 * time.MINUTE_MS;

/** Workers' names double as hostnames, so they fit a DNS label. */
export const MAX_WORKER_NAME = 63;

export const WRANGLER = ["npx", "-y", "wrangler@4"];

/** Bun, as the router and deployer get it on their first start: Cloudflare's image has only Node. */
export const BUN_VERSION = "1.4.3";

/** Every container: `lite` is too small for a 2 GB image. */
export const INSTANCE = "standard-1";

/** A variable holding a hash of what a Worker was last deployed with. */
export const DEPLOYED = "deployed";

/** How often a deploy is checked on, and how long it can take: Builds take 1.5 to 3 minutes, with no layer cache. */
export const BUILD_POLL_INTERVAL_MS = 10_000;
export const BUILD_TIMEOUT_MS = 30 * time.MINUTE_MS;
/** How often the router is checked while waiting for it to answer after a deploy, and how long to wait in all: its first start installs Bun and achq. */
export const ANSWER_POLL_INTERVAL_MS = 5000;
export const ANSWER_TIMEOUT_MS = 5 * time.MINUTE_MS;
/** How much of a failed build's log its error quotes. */
export const LOG_TAIL_LINES = 30;

/** Cloudflare's GitHub App, "Cloudflare Workers and Pages", which Workers Builds clones repos with. */
export const BUILDS_GITHUB_APP = "cloudflare-workers-and-pages";
/** Where you install it: only Cloudflare can tell whether it sees a repo, when the deployer connects the repo to Workers Builds. */
export const BUILDS_GITHUB_APP_INSTALL_URL = `https://github.com/apps/${BUILDS_GITHUB_APP}/installations/new`;
/** What Workers Builds answers connecting a repo its GitHub App can't see: "The project is linked to a repository that no longer exists". */
export const REPO_UNSEEN = 8000012;

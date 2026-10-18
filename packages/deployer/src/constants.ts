import type { FileLimits } from "./clients/github.ts";

/**
 * What the deployer's own token needs on a repo: read `.achq/` and write the
 * ACHQ_STATUS variable. `actions_variables` is the token key for the
 * "Variables" repository permission. The OpenAPI `app-permissions` schema
 * doesn't list it, but GitHub's endpoint docs do:
 * https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
 */
export const DEPLOYER_PERMISSIONS = { contents: "read", metadata: "read", actions_variables: "write" } as const;

/** GitHub's rules for owner and repository names. */
export const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const DEFAULT_FILE_LIMITS: FileLimits = { maxFiles: 200, maxBytes: 1024 * 1024 };

/** How many handled delivery IDs are remembered. */
export const MAX_DELIVERIES = 5000;

export const DEFAULT_DATA_DIR = "/data";
/** The achq commit containers run when ACHQ_REF isn't set. */
export const DEFAULT_REF = "main";

/** The loader for each file extension evaluation reads. */
export const LOADERS = { ts: "ts", mts: "ts", tsx: "tsx", js: "js", mjs: "js", json: "json" } as const;

/** Where `.achq/`, achq's own modules and the entry module sit in the sandbox's module names. */
export const SANDBOX_ROOT = "/.achq";
export const SANDBOX_LIB = "/achq";
export const SANDBOX_ENTRY = "/entry.js";
/** What a config's bare imports resolve to. */
export const SANDBOX_IMPORTS: Record<string, string> = { achq: `${SANDBOX_LIB}/index.js`, "achq/github": `${SANDBOX_LIB}/github.js` };

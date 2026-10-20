import * as path from "node:path";
import { ENV } from "@achq/core";

/** achq's prompt templates: the runner's system prompt, and one per session mode. */
export const PROMPTS = path.join(import.meta.dir, "..", "prompts");
export const RUNNER_PROMPT_FILE = "system.md";

export const MINUTE_MS = 60_000;

/** Where the volume is when DATA_DIR doesn't say. */
export const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_MAX_RUNS = 2;
export const DEFAULT_RUN_TIMEOUT_MINUTES = 360;
/** Variables that override those defaults. */
export const MAX_RUNS_ENV = "ACHQ_MAX_RUNS";
export const RUN_TIMEOUT_MINUTES_ENV = "ACHQ_RUN_TIMEOUT_MINUTES";

/** The repo's config directory. */
export const CONFIG_DIR = ".achq";

/** Refresh when this little is left, so a failing refresh has half an hour of retries before anything breaks. */
export const REFRESH_BEFORE_MS = 30 * MINUTE_MS;

/** How often a working container fetches ENV.keepAwakeUrl, when its container provider sets one. */
export const KEEP_AWAKE_INTERVAL_MS = 3 * MINUTE_MS;

/**
 * Never handed to an agent. The container secret proves the container's
 * identity to the router, so an agent holding it could mint every credential
 * the container has and post as the channel. The key only exists on the router
 * and deployer. Every implementation's own private variables are listed
 * in ENV.privateEnv, which the deployer sets.
 */
export const PRIVATE_ENV: string[] = [ENV.containerSecret, ENV.key, ENV.privateEnv];

/** How often `resume` checks whether the SSH shell that started it has gone. */
export const ORPHAN_CHECK_INTERVAL_MS = 1000;

import * as path from "node:path";

/** achq's prompt templates: the runner's system prompt, and one per session mode. */
export const PROMPTS = path.join(import.meta.dir, "..", "prompts");
export const RUNNER_PROMPT_FILE = "system.md";

/** Where the volume is when DATA_DIR doesn't say. */
export const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_MAX_RUNS = 2;
export const DEFAULT_RUN_TIMEOUT_MINUTES = 360;

/** The repo's config directory, and the bare imports a config may use. */
export const CONFIG_DIR = ".achq";
export const CONFIG_IMPORTS = ["achq", "achq/github"];

/** Refresh when this little is left, so a failing refresh has half an hour of retries before anything breaks. */
export const REFRESH_BEFORE_MS = 30 * 60_000;

/** Railway sleeps a service after minutes without outbound traffic. Any request counts. */
export const KEEP_AWAKE_URL = "https://api.github.com/zen";
export const KEEP_AWAKE_INTERVAL_MS = 3 * 60_000;

/**
 * Never handed to an agent. The container secret proves the container's
 * identity to the router, so an agent holding it could mint every credential
 * the container has and post as the channel. The rest only exist on the router
 * or deployer. They're listed in case an image or a misconfigured service sets them.
 */
export const PRIVATE_ENV = [
  "ACHQ_CONTAINER_SECRET",
  "AGENT_WEBHOOK_KEY",
  "ACHQ_GITHUB_APPS",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "RAILWAY_TOKEN",
];

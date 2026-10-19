/** The router and deployer run on the stock Bun image. */
export const BUN_IMAGE = "oven/bun:1-slim";

/** A variable holding a hash of the settings and variables a service was last deployed with. */
export const DEPLOYED = "ACHQ_DEPLOYED";

/** How often the router's deploy is checked while waiting for it to go live, and how many times: five minutes in all. */
export const DEPLOY_POLL_INTERVAL_MS = 5000;
export const DEPLOY_POLL_ATTEMPTS = 60;

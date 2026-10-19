import { RAILWAY_ENV } from "../lib/constants.ts";

/** What only the CLI and deployer have; the second is what Railway's own CLI reads. */
export const PRIVATE_ENV = [RAILWAY_ENV.token, "RAILWAY_TOKEN"];

/** Railway builds a container's service from its repo through its GitHub integration. */
export const SOURCE_HOST = "github";

/** The branch a container's service was last connected to, as `owner/repo@branch`. */
export const CONNECTED = "ACHQ_CONNECTED";
/** The branch a container's service builds from. */
export const BRANCH = "ACHQ_BRANCH";

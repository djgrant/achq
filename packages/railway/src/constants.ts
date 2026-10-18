export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

/** Where achq's own code is downloaded from. */
export const ACHQ_SOURCE = "djgrant/achq";
/** The router and deployer run on the stock Bun image. */
export const BUN_IMAGE = "oven/bun:1-slim";

/** Where every service's volume is mounted. */
export const VOLUME = "/data";

/** Services reach each other at `<service>.<PRIVATE_DOMAIN>` over the project's private network. */
export const PRIVATE_DOMAIN = "railway.internal";

/** Railway service names double as hostnames, so they fit a DNS label. */
export const MAX_SERVICE_NAME = 63;

/** The router's and deployer's service names start with this. */
export const HOST_SERVICE_PREFIX = "achq";

/** A variable holding a hash of the settings and variables a service was last deployed with. */
export const DEPLOYED = "ACHQ_DEPLOYED";
/** The branch a container's service was last connected to, as `owner/repo@branch`. */
export const CONNECTED = "ACHQ_CONNECTED";
/** The branch a container's service builds from. */
export const BRANCH = "ACHQ_BRANCH";

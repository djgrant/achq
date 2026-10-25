import * as infra from "./infra.ts";

/*
 * What the config sandbox and the infra file may import, by bare specifier.
 */

/** The bare imports a repo's `.achq/` may use. */
export const CONFIG_MODULES = ["achq", "achq/github", "achq/claude"];
/** What the infra file's imports resolve to. */
export const INFRA_MODULES: Record<string, object> = { "achq/infra": infra };

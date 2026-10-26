import * as cloudflare from "@achq/cloudflare/infra";
import * as core from "@achq/core";
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";

/*
 * What the config sandbox and the infra file may import, by bare specifier.
 */

/** The bare imports a repo's `.achq/` may use. */
export const CONFIG_MODULES = ["@achq/core", "@achq/github", "@achq/claude"];
/** What the infra file's imports resolve to. */
export const INFRA_MODULES: Record<string, object> = {
  "@achq/core": core,
  "@achq/cloudflare/infra": cloudflare,
  "@achq/github/infra": github,
  "@achq/railway/infra": railway,
};

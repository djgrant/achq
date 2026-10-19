import type { AccessProvider, Implementation } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { PRIVATE_ENV, ACCESS } from "../lib/constants.ts";
import { GitHubAccess } from "./access.ts";

/** RepoPolicies, as App installation tokens. Shares the channel's Apps (and JWT cache) when made from the same configuration. */
export const githubAccess: Implementation<AccessProvider> = {
  id: ACCESS,
  create: (env) => new GitHubAccess(appsFor(env)),
  privateEnv: PRIVATE_ENV,
};

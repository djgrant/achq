import type { Implementation, PolicyProvider } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { POLICY_PROVIDER, PRIVATE_ENV } from "../lib/constants.ts";
import { GitHubPolicyProvider } from "./provider.ts";

/** The router's instance has the App keys that mint tokens; a container's only installs them. */
export const githubPolicyProvider: Implementation<PolicyProvider> = {
  id: POLICY_PROVIDER,
  create: (env) => new GitHubPolicyProvider(appsFor(env)),
  privateEnv: PRIVATE_ENV,
};

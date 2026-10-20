import type { Implementation, PolicyProvider } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { POLICY_PROVIDER, PRIVATE_ENV } from "../lib/constants.ts";
import { GitHubPolicyProvider } from "./provider.ts";

/** Shares the channel's Apps (and JWT cache) when made from the same configuration. */
export const githubPolicyProvider: Implementation<PolicyProvider> = {
  id: POLICY_PROVIDER,
  create: (env) => new GitHubPolicyProvider(appsFor(env)),
  privateEnv: PRIVATE_ENV,
};

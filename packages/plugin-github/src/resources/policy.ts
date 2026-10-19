import { Policy as CorePolicy } from "@achq/core";
import { POLICY_PROVIDER } from "../lib/constants.ts";
import type { AppRef } from "../channels/app-ref.ts";

export type Permission = "read" | "write";

export type GitHubPolicyData = {
  provider: typeof POLICY_PROVIDER;
  /** The App the policy grants through: the channel source. */
  source: string;
  /** `owner/name`, or null for the repo the config is in. */
  repo: string | null;
  permissions: Record<string, Permission>;
};

/** Access to one repo through an App's installation. Defaults to the config's own repo. */
export class Policy extends CorePolicy {
  constructor(name: string, inputs: { app: AppRef; repo?: string; permissions: Record<string, Permission> }) {
    const data: GitHubPolicyData = { provider: POLICY_PROVIDER, source: inputs.app.slug, repo: inputs.repo ?? null, permissions: inputs.permissions };
    super(name, data);
  }
}

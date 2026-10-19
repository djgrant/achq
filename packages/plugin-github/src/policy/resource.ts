import { Policy as CorePolicy } from "@achq/core";
import { POLICY_PROVIDER } from "../lib/constants.ts";
import type { ChannelRef } from "../channel/config.ts";

export type Permission = "read" | "write";

export type GitHubPolicyData = {
  provider: typeof POLICY_PROVIDER;
  /** The App the policy grants through: the channel source. Without one, whichever App is installed on the repo. */
  source?: string;
  /** `owner/name`, or null for the repo the config is in. */
  repo: string | null;
  permissions: Record<string, Permission>;
};

/** Access to one repo through its channel's App installation. Defaults to the config's own repo. */
export class Policy extends CorePolicy {
  constructor(name: string, inputs: { channel: ChannelRef; repo?: string; permissions: Record<string, Permission> }) {
    const data: GitHubPolicyData = { provider: POLICY_PROVIDER, source: inputs.channel.slug, repo: inputs.repo ?? null, permissions: inputs.permissions };
    super(name, data);
  }
}

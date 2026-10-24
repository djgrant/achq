import { Policy as CorePolicy } from "@achq/core";
import { POLICY_PROVIDER } from "../lib/constants.ts";
import type { ChannelRef } from "../channel/config.ts";
import type { GitHubPolicyData, Permission } from "../lib/schemas.ts";

export type { GitHubPolicyData, Permission };

export class Policy extends CorePolicy {
  constructor(name: string, inputs: { channel: ChannelRef; repo?: string; permissions: Record<string, Permission> }) {
    const data: GitHubPolicyData = { provider: POLICY_PROVIDER, source: inputs.channel.slug, repo: inputs.repo ?? null, permissions: inputs.permissions };
    super(name, data);
  }
}

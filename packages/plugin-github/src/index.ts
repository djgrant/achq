// What a repo's config imports. Runs in the deployer's sandbox, so it imports
// no Node code: the Channel resource, which does, is in infra.ts.
import { ChannelRef } from "./channels/channel-ref.ts";

export { ChannelRef } from "./channels/channel-ref.ts";
export { type IssueFilter, Issues, type IssueSelectorData } from "./channels/issues.ts";
export type { CommentAction, EventSelectorData, IssueAction } from "./channels/selectors.ts";
export { type GitHubPolicyData, type Permission, Policy } from "./resources/policy.ts";

/** A channel the ACHQ infra declares, adopted by its App's slug: `github.Channel.get("notation-achq")`. */
export const Channel = { get: (slug: string) => new ChannelRef(slug) };

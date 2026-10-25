import { ChannelRef } from "./channel/config.ts";

export { ChannelRef } from "./channel/config.ts";
export { STATUS_VARIABLE } from "./lib/constants.ts";
export { type CommentAction, type EventSelectorData, type IssueAction, type IssueFilter, Issues, type IssueSelectorData } from "./lib/selectors.ts";
export { type GitHubPolicyData, type Permission, Policy } from "./policy/resource.ts";

/** A channel the ACHQ infra declares, adopted by its App's slug: `github.Channel.get("notation-achq")`. */
export const Channel = { get: (slug: string) => new ChannelRef(slug) };

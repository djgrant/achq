// What a repo's config imports. Runs in the deployer's sandbox, so it imports
// no Node code: the App resource, which does, is in infra.ts.
import { AppRef } from "./channels/app-ref.ts";

export { AppRef } from "./channels/app-ref.ts";
export { type IssueFilter, Issues, type IssueSelectorData } from "./channels/issues.ts";
export type { CommentAction, EventSelectorData, IssueAction } from "./channels/selectors.ts";
export { type GitHubPolicyData, type Permission, Policy } from "./resources/policy.ts";

/** An App the ACHQ infra declares, adopted by slug: `github.App.get("notation-achq")`. */
export const App = { get: (slug: string) => new AppRef(slug) };

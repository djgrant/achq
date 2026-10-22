import type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";

type ResponseData<T extends { response: { data: unknown } }> = T["response"]["data"];
type Rest = RestEndpointMethodTypes;

/** Permission name to level: `{ contents: "write" }`. */
export type Permissions = Record<string, string>;

/** What an App sends and is allowed. */
export type AppSettings = { events: string[]; permissions: Permissions };

/** An App's installation on an account, as the App sees it. An enterprise account has no login: it's "". */
/** `account.type` is `User` or `Organization`. */
export type Installation = { id: number; app_slug: string; account: { login: string; type: string }; permissions: Permissions; repository_selection: "all" | "selected"; suspended_at: string | null };

/** What an installation token is narrowed to: repo names (not owner/name) and permissions. */
export type TokenNarrowing = { repositories?: string[]; permissions?: Permissions };

/** An issue's opening post, or one of its comments. */
export type ReactionTarget = { issue: number } | { comment: number };

export type ReactionContent = Rest["reactions"]["createForIssue"]["parameters"]["content"];
export type CommitSummary = ResponseData<Rest["repos"]["listCommits"]>[number];
export type TreeEntry = ResponseData<Rest["git"]["getTree"]>["tree"][number];
export type HookConfig = ResponseData<Rest["apps"]["getWebhookConfigForApp"]>;
/** The App the manifest flow created, with its private key. */
export type CreatedApp = ResponseData<Rest["apps"]["createFromManifest"]>;
export type User = ResponseData<Rest["users"]["getByUsername"]>;
export type Issue = ResponseData<Rest["issues"]["get"]>;
export type IssueComment = ResponseData<Rest["issues"]["getComment"]>;

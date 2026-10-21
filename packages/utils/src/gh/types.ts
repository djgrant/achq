import type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";

type Data<T extends { response: { data: unknown } }> = T["response"]["data"];
type Rest = RestEndpointMethodTypes;

/** Permission name to level: `{ contents: "write" }`. */
export type Permissions = Record<string, string>;

/** What an App sends and is allowed. */
export type AppSettings = { events: string[]; permissions: Permissions };

/** An App's installation on an account, as the App sees it. An enterprise account has no login: it's "". */
export type Installation = { id: number; account: { login: string }; permissions: Permissions; suspended_at: string | null };

/** An installation your login can see. */
export type UserInstallation = Installation & { app_slug: string; account: { type: string }; repository_selection: "all" | "selected" };

/** What an installation token is narrowed to: repo names (not owner/name) and permissions. */
export type TokenNarrowing = { repositories?: string[]; permissions?: Permissions };

/** An issue's opening post, or one of its comments. */
export type ReactionTarget = { issue: number } | { comment: number };

export type ReactionContent = Rest["reactions"]["createForIssue"]["parameters"]["content"];
export type CommitSummary = Data<Rest["repos"]["listCommits"]>[number];
export type TreeEntry = Data<Rest["git"]["getTree"]>["tree"][number];
export type HookConfig = Data<Rest["apps"]["getWebhookConfigForApp"]>;
/** The App the manifest flow created, with its private key. */
export type CreatedApp = Data<Rest["apps"]["createFromManifest"]>;
export type User = Data<Rest["users"]["getByUsername"]>;
export type Issue = Data<Rest["issues"]["get"]>;
export type IssueComment = Data<Rest["issues"]["getComment"]>;

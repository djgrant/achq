// The fields of GitHub's responses that callers read. GitHub sends more; these
// name only what's relied on.

/** Permission name to level: `{ contents: "write" }`. */
export type Permissions = Record<string, string>;

/** `GET /repos/{r}`. `permissions` is the caller's, and only there for a user token. */
export type RepoInfo = { id: number; full_name: string; default_branch: string; permissions?: { push?: boolean } };

/** One of `GET /repos/{r}/commits`. */
export type CommitSummary = { sha: string; commit: { committer: { date: string } } };

/** An item of a repo listing. */
export type RepoName = { full_name: string };

export type GitRef = { ref?: string; object: { sha: string } };
export type GitCommit = { sha: string; tree: { sha: string } };
export type TreeEntry = { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number };
export type GitTree = { sha: string; tree: TreeEntry[]; truncated?: boolean };
export type GitBlob = { content: string; encoding: "base64" | "utf-8" | string };

export type Variable = { name: string; value: string };

export type AppSettings = { events: string[]; permissions: Permissions };

/** `GET /app`, and `GET /apps/{slug}` for a public one. */
export type AppInfo = AppSettings & { id: number; slug: string };

/** `GET /app/hook/config`. GitHub never shows the secret back. */
export type HookConfig = { url?: string; content_type?: string; insecure_ssl?: string; secret?: string };

/** An App's installation, as the App sees it: `GET /app/installations` and `GET /repos/{r}/installation`. */
export type Installation = { id: number; account: { login: string }; permissions: Permissions; suspended_at?: string | null };

/** What an installation token is narrowed to: repo names (not owner/name) and permissions. */
export type TokenNarrowing = { repositories?: string[]; permissions?: Permissions };

export type AccessToken = { token: string; expires_at: string; permissions?: Permissions };

/** `POST /app-manifests/{code}/conversions`: the App the manifest flow created, with its private key. */
export type CreatedApp = { id: number; slug: string; pem: string; html_url: string };

/** An installation your login can see: `GET /user/installations`. */
export type UserInstallation = {
  id: number;
  app_slug: string;
  account: { login: string; type: "User" | "Organization" | string };
  repository_selection: "all" | "selected";
};

export type User = { id: number; login: string };

type Authored = { user?: { login: string; type?: string } | null; author_association: string; body?: string | null; created_at: string };

export type Issue = Authored & { number: number; title: string; html_url: string; labels: (string | { name?: string })[] };

export type IssueComment = Authored & { id: number };

export type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

/** An issue's opening post, or one of its comments. */
export type ReactionTarget = { issue: number } | { comment: number };

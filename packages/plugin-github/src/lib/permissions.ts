export type Permissions = Record<string, string>;

const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

export const covers = (granted: string | undefined, wanted: string) =>
  granted !== undefined && (PERMISSION_RANK[granted] ?? 0) >= (PERMISSION_RANK[wanted] ?? Infinity);

export const maxLevel = (a: string | undefined, b: string) =>
  a !== undefined && (PERMISSION_RANK[a] ?? 0) >= (PERMISSION_RANK[b] ?? 0) ? a : b;

export const POLICY_LEVELS = new Set(["read", "write"]);

/** What every channel's App sends and is allowed. Installation events are always sent. */
export const APP_EVENTS = ["issues", "issue_comment", "push"];
export const APP_PERMISSIONS: Permissions = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
  // For the deployer's ACHQ_STATUS repository variable.
  actions_variables: "write",
};

/** What any repo's config needs from its App: pushes keep the deployment in line with the config, and the deployer writes ACHQ_STATUS. */
export const CONFIG_EVENTS = ["push"];
export const CONFIG_PERMISSIONS: Permissions = { metadata: "read", actions_variables: "write" };

/** What the runner's channel credential can do: read the repo, and comment and react on issues. */
export const CLIENT_PERMISSIONS: Permissions = { issues: "write", contents: "read", metadata: "read" };

/**
 * What the deployer's own token needs on a repo: read `.achq/` and write the
 * ACHQ_STATUS variable. `actions_variables` is the token key for the
 * "Variables" repository permission. The OpenAPI `app-permissions` schema
 * doesn't list it, but GitHub's endpoint docs do:
 * https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
 */
export const DEPLOYER_PERMISSIONS = { contents: "read", metadata: "read", actions_variables: "write" } as const;

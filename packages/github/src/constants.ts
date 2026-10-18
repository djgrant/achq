export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
export const API_VERSION = "2022-11-28";
export const USER_AGENT = "achq";

/** The channel's id, in events, selectors and channel credentials. */
export const CHANNEL = "github";
/** The access provider's id, in policies and agent credentials. */
export const PROVIDER = "github";

/** `owner/name`. */
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The directory whose changes redeploy a repo. */
export const CONFIG_DIR = ".achq/";

/** App JWTs are valid for nine minutes and reused for five. */
export const JWT_REUSE_MS = 5 * 60_000;

/** read < write < admin. */
export const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** The levels a RepoPolicy may ask for. */
export const POLICY_LEVELS = new Set(["read", "write"]);

/** Author associations that mean write access to the repo. */
export const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** What the runner's channel credential can do: read the repo, and comment and react on issues. */
export const CLIENT_PERMISSIONS: Record<string, string> = { issues: "write", contents: "read", metadata: "read" };

/**
 * A webhook `push` payload's `commits` array "includes a maximum of 2048
 * commits" (https://docs.github.com/en/webhooks/webhook-events-and-payloads#push).
 * A push listing that many may have dropped some, so it can't tell us whether
 * `.achq/` changed. The limit of 20 is the Events API's, not webhooks'.
 */
export const PUSH_COMMIT_CAP = 2048;

/** The webhook actions achq acts on, per event. */
export const ISSUE_ACTIONS = new Set(["opened", "edited", "reopened", "labeled"]);
export const COMMENT_ACTIONS = new Set(["created", "edited"]);
export const INSTALLATION_ACTIONS = new Set(["created", "deleted", "suspend", "unsuspend"]);
export const INSTALLATION_REPOS_ACTIONS = new Set(["added", "removed"]);

/** What `GitHubAccess.install` writes in its directory. */
export const GH_CONFIG_DIR = "gh";
export const GH_HOSTS_FILE = "hosts.yml";
export const GIT_CONFIG_FILE = "gitconfig";
export const TOKEN_SUFFIX = ".token";

/** The variables GitHub's parts read. */
export const GITHUB_ENV = {
  /** `{ [slug]: { id, privateKey } }` as JSON. Router only: `achq up` sets it. */
  apps: "ACHQ_GITHUB_APPS",
  /** Points the API client at a fake. */
  api: "GITHUB_API_URL",
  /** Points web links and clone URLs at a fake. */
  web: "GITHUB_WEB_URL",
} as const;

/** Variables that only exist on the router, or that an App's own tooling sets. */
export const PRIVATE_ENV = [GITHUB_ENV.apps, "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID"];

/**
 * What the deployer's own token needs on a repo: read `.achq/` and write the
 * ACHQ_STATUS variable. `actions_variables` is the token key for the
 * "Variables" repository permission. The OpenAPI `app-permissions` schema
 * doesn't list it, but GitHub's endpoint docs do:
 * https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
 */
export const DEPLOYER_PERMISSIONS = { contents: "read", metadata: "read", actions_variables: "write" } as const;

/** GitHub's rules for owner and repository names. */
export const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** What every achq App sends and is allowed. Installation events are always sent. */
export const APP_EVENTS = ["issues", "issue_comment", "push"];
export const APP_PERMISSIONS: Record<string, string> = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
  // For the deployer's ACHQ_STATUS repository variable.
  actions_variables: "write",
};

/** What any repo's config needs from its App: pushes keep the deployment in line with the config, and the deployer writes ACHQ_STATUS. */
export const CONFIG_EVENTS = ["push"];
export const CONFIG_PERMISSIONS: Record<string, string> = { metadata: "read", actions_variables: "write" };

/** The homepage every App's manifest links to. */
export const ACHQ_HOMEPAGE = "https://github.com/djgrant/achq";

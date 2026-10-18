export const GITHUB_API = "https://api.github.com";
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

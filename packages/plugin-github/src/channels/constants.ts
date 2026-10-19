/** The directory whose changes redeploy a repo. */
export const CONFIG_DIR = ".achq/";

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

/** What any repo's config needs from its App: pushes keep the deployment in line with the config, and the deployer writes ACHQ_STATUS. */
export const CONFIG_EVENTS = ["push"];
export const CONFIG_PERMISSIONS: Record<string, string> = { metadata: "read", actions_variables: "write" };

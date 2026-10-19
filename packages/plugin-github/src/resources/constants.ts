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

/** The homepage every App's manifest links to. */
export const ACHQ_HOMEPAGE = "https://github.com/djgrant/achq";

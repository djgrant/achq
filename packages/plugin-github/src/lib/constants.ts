export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";

/** The channel's id, in events, selectors and channel credentials. */
export const CHANNEL = "github";
/** The policy provider's id, in policies and agent credentials. */
export const POLICY_PROVIDER = "github";
/** The code host's id, in installed repos, events and deploy records. */
export const CODE_HOST = "github";

/** `owner/name`. */
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** GitHub's rules for owner and repository names. */
export const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

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

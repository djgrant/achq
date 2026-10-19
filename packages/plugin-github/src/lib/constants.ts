export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
export const API_VERSION = "2022-11-28";
export const USER_AGENT = "achq";

/** The channel's id, in events, selectors and channel credentials. */
export const CHANNEL = "github";
/** The access provider's id, in policies and agent credentials. */
export const ACCESS = "github";
/** The code host's id, in installations, events and deploy records. */
export const CODE_HOST = "github";

/** `owner/name`. */
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** App JWTs are valid for nine minutes and reused for five. */
export const JWT_REUSE_MS = 5 * 60_000;

/** read < write < admin. */
export const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

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

/** Milliseconds between attempts while a sleeping service wakes: about five minutes in all. */
export const DELAYS = [2, 4, 8, 15, 30, 30, 30, 30, 60, 60].map((s) => s * 1000);

/** How long one attempt to deliver an event or wake a service may take. */
export const ATTEMPT_TIMEOUT_MS = 30_000;

/** `owner/repo`, in characters that can't escape a path or a directory. */
export const REPO = /^[\w.-]+\/[\w.-]+$/;

/** Where state goes without a volume. */
export const DEFAULT_DATA_DIR = "./data";

/** Every admin route is under this, on both ports. */
export const ADMIN_PREFIX = "/admin/";

/** `PUT` and `DELETE` take the repo after this: `/admin/repos/<owner>/<repo>`. */
export const ADMIN_REPO_PREFIX = "/admin/repos/";

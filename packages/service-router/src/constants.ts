/** Milliseconds between attempts while a sleeping service wakes: about five minutes in all. */
export const DELAYS = [2, 4, 8, 15, 30, 30, 30, 30, 60, 60].map((s) => s * 1000);

export const ATTEMPT_TIMEOUT_MS = 30_000;

/** `owner/repo`, in characters that can't escape a path or a directory. */
export const REPO = /^[\w.-]+\/[\w.-]+$/;
/** A route's `/repos/<owner>/<repo>`, in the same characters. */
export const REPO_PATH = "/repos/:owner{[\\w.-]+}/:name{[\\w.-]+}";

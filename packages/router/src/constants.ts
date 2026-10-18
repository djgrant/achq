/** Milliseconds between attempts while a sleeping service wakes: about five minutes in all. */
export const DELAYS = [2, 4, 8, 15, 30, 30, 30, 30, 60, 60].map((s) => s * 1000);

/** How long one attempt to deliver an event or wake a service may take. */
export const ATTEMPT_TIMEOUT_MS = 30_000;

export const GITHUB_API = "https://api.github.com";
export const USER_AGENT = "achq-router";

export const REPO = /^[\w.-]+\/[\w.-]+$/;

/** File names come from delivery IDs and repo names, so only allow characters that can't escape the directory. */
export const SAFE_NAME = /^[\w-][\w.-]*$/;

/** Where state goes without a volume. */
export const DEFAULT_DATA_DIR = "./data";

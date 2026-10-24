import { repoName } from "@achq/core";

/** Milliseconds between attempts while a sleeping service wakes: about five minutes in all. */
export const DELAYS = [2, 4, 8, 15, 30, 30, 30, 30, 60, 60].map((s) => s * 1000);

export const ATTEMPT_TIMEOUT_MS = 30_000;

/** A route's `/repos/<owner>/<repo>`, in characters that can't escape a path. */
export const REPO_PATH = `/repos/:owner{${repoName.segment}}/:name{${repoName.segment}}`;

/** What a channel's delivery ID may be: it's kept by, and names files and keys, so it's held to a short run of plain characters. */
export const DELIVERY_ID = /^[\w.-]{1,200}$/;

import { SessionSummary } from "@achq/core/protocol";
import * as v from "valibot";
import type { Paths } from "../features/layout.ts";
import { sessionsFor } from "../state.ts";

/**
 * A JSON array of their summaries, only: the laptop's `achq container resume` parses it (parseSessions in packages/cli/tasks/container.list-sessions.ts).
 * SessionSummary is loose, for reading what another version printed, so the summary's own shape strips the rest.
 */
const summaries = v.array(v.object(SessionSummary.entries));
export const formatSessions = (sessions: SessionSummary[]) => JSON.stringify(v.parse(summaries, sessions));

/** `sessions [thread]`: prints a thread's sessions, or every thread's, for the CLI. */
export const sessions = (paths: Paths, thread?: string) => {
  console.log(formatSessions(sessionsFor(paths, thread)));
};

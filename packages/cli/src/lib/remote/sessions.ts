import type { SessionSummary } from "@achq/core";
import { alignedTable } from "@achq/utils/text";

/** How much of unexpected output goes into the error: enough to see what answered. */
const UNEXPECTED_OUTPUT_CHARS = 200;
const SESSION_COLUMNS = ["ID", "AGENT", "LAST RUN"];

/**
 * `achq-agent sessions <n>`'s output: a JSON array of sessions, most recently
 * run first. Anything before the JSON (an SSH banner) is skipped.
 */
export const parseSessions = (out: string): SessionSummary[] => {
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`Unexpected output from achq-agent sessions: ${out.trim().slice(0, UNEXPECTED_OUTPUT_CHARS)}`);
  const rows = JSON.parse(out.slice(start)) as SessionSummary[];
  if (!Array.isArray(rows)) throw new Error("achq-agent sessions didn't return a list");
  return rows;
};

/** The session to open: the one asked for, the only one, or `undefined` to ask. */
export const pickSession = (sessions: SessionSummary[], wanted?: string) => {
  if (wanted) {
    const found = sessions.find((s) => s.id === wanted || s.id.startsWith(wanted) || s.agent === wanted);
    if (!found) throw new Error(`No session ${wanted}`);
    return found;
  }
  if (!sessions.length) throw new Error("The thread has no sessions");
  return sessions.length === 1 ? sessions[0] : undefined;
};

export const sessionLabel = (s: SessionSummary) => `${s.agent} (${s.workspace})`;

/** The minimal list, for when there's no terminal to pick in. */
export const sessionTable = (sessions: SessionSummary[]) =>
  alignedTable([SESSION_COLUMNS, ...sessions.map((s) => [s.id, sessionLabel(s), s.lastRun])]).join("\n");

import { SessionSummary } from "@achq/core/protocol";
import { text } from "@achq/utils/text";
import { z } from "zod";

/** How much of unexpected output goes into the error: enough to see what answered. */
const UNEXPECTED_OUTPUT_CHARS = 200;
const SESSION_COLUMNS = ["ID", "THREAD", "AGENT", "LAST RUN"];

/**
 * `achq-agent sessions [n]`'s output: a JSON array of sessions, most recently
 * run first. Anything before the JSON (an SSH banner) is skipped.
 */
export const parseSessions = (out: string): SessionSummary[] => {
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`Unexpected output from achq-agent sessions: ${out.trim().slice(0, UNEXPECTED_OUTPUT_CHARS)}`);
  const sessions = z.array(SessionSummary).safeParse(JSON.parse(out.slice(start)));
  if (!sessions.success) throw new Error(`achq-agent sessions didn't return a list of sessions: ${z.prettifyError(sessions.error)}`);
  return sessions.data;
};

/** The session to open: the one asked for, the only one, or `undefined` to ask. */
export const pickSession = (sessions: SessionSummary[], wanted?: string, thread?: string) => {
  if (wanted) {
    const found = sessions.find((s) => s.id === wanted || s.id.startsWith(wanted) || s.agent === wanted);
    if (!found) throw new Error(`No session ${wanted}`);
    return found;
  }
  if (!sessions.length) throw new Error(thread ? `Thread ${thread} has no sessions` : "There are no sessions yet: mention an agent on an issue to start one");
  return sessions.length === 1 ? sessions[0] : undefined;
};

export const sessionLabel = (s: SessionSummary) => `#${s.thread} ${s.agent} (${s.workspace})`;

/** The minimal list, for when there's no terminal to pick in. */
export const sessionTable = (sessions: SessionSummary[]) =>
  text.alignedTable([SESSION_COLUMNS, ...sessions.map((s) => [s.id, `#${s.thread}`, `${s.agent} (${s.workspace})`, s.lastRun])]).join("\n");

import type { SessionSummary } from "@achq/core/protocol";
import { text } from "@achq/utils/text";

const SESSION_COLUMNS = ["ID", "THREAD", "AGENT", "LAST RUN"];

/** A session as a picker shows it. */
export const sessionLabel = (s: SessionSummary) => `#${s.thread} ${s.agent} (${s.workspace})`;

/** The minimal list, for when there's no terminal to pick in. */
export const sessionTable = (sessions: SessionSummary[]) =>
  text.alignedTable([SESSION_COLUMNS, ...sessions.map((s) => [s.id, `#${s.thread}`, `${s.agent} (${s.workspace})`, s.lastRun])]).join("\n");

export type SessionRow = { id: string; agent: string; workspace?: string; lastRun?: string };

/**
 * `achq-agent sessions <n>`'s output: a JSON array of sessions. Anything
 * before the JSON (an SSH banner) is skipped.
 */
export const parseSessions = (out: string): SessionRow[] => {
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`Unexpected output from achq-agent sessions: ${out.trim().slice(0, 200)}`);
  const rows = JSON.parse(out.slice(start)) as SessionRow[];
  if (!Array.isArray(rows)) throw new Error("achq-agent sessions didn't return a list");
  return rows.sort((a, b) => (b.lastRun ?? "").localeCompare(a.lastRun ?? ""));
};

/** The session to open: the one asked for, the only one, or `undefined` to ask. */
export const pickSession = (sessions: SessionRow[], wanted?: string) => {
  if (wanted) {
    const found = sessions.find((s) => s.id === wanted || s.id.startsWith(wanted) || s.agent === wanted);
    if (!found) throw new Error(`No session ${wanted}`);
    return found;
  }
  if (!sessions.length) throw new Error("The thread has no sessions");
  return sessions.length === 1 ? sessions[0] : undefined;
};

export const sessionLabel = (s: SessionRow) => `${s.agent}${s.workspace ? ` (${s.workspace})` : ""}`;

/** The minimal list, for when there's no terminal to pick in. */
export const sessionTable = (sessions: SessionRow[]) => {
  const rows = [["ID", "AGENT", "LAST RUN"], ...sessions.map((s) => [s.id, sessionLabel(s), s.lastRun ?? "-"])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
};

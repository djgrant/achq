import type { SessionSummary } from "@achq/core/protocol";

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

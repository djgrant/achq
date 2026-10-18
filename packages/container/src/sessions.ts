import type { Paths } from "./paths.ts";
import { allStates, type ThreadState } from "./state.ts";

export type SessionInfo = { id: string; agent: string; workspace: string; lastRun: string };

const threadNumber = (state: ThreadState) => state.number ?? state.thread.id.match(/#(\w+)$/)?.[1];

/** A thread's sessions, most recently run first. */
export const sessionsFor = (paths: Paths, number: string): (SessionInfo & { state: ThreadState; commit: string })[] =>
  allStates(paths.threads)
    .filter(({ state }) => threadNumber(state) === number)
    .flatMap(({ state }) =>
      Object.entries(state.sessions).map(([agent, s]) => ({ id: s.id, agent, workspace: state.workspace, lastRun: s.lastRun, state, commit: s.commit })),
    )
    .sort((a, b) => b.lastRun.localeCompare(a.lastRun));

/** A JSON array. The laptop's `achq resume` parses it (parseSessions in packages/cli/src/lib/remote.ts). */
export const formatSessions = (sessions: SessionInfo[]) =>
  JSON.stringify(sessions.map(({ id, agent, workspace, lastRun }) => ({ id, agent, workspace, lastRun })));

/**
 * Which session `resume` opens: the one named (by ID, or by agent if that's
 * unambiguous), or the only one. Otherwise there's nothing to pick from here.
 */
export const pickSession = <T extends SessionInfo>(sessions: T[], wanted?: string): { session: T } | { error: string } => {
  if (!sessions.length) return { error: "This thread has no sessions." };
  if (wanted) {
    const byId = sessions.filter((s) => s.id === wanted);
    const matches = byId.length ? byId : sessions.filter((s) => s.agent === wanted);
    if (matches.length === 1) return { session: matches[0]! };
    return { error: matches.length ? `Several sessions match "${wanted}":` : `No session matches "${wanted}". This thread's sessions:` };
  }
  if (sessions.length === 1) return { session: sessions[0]! };
  return { error: "This thread has several sessions; name one:" };
};

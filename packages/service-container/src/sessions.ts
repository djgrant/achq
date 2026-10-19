import type { SessionSummary } from "@achq/core";
import type { Paths } from "./paths.ts";
import { allStates, type ThreadState } from "./state.ts";

/** A thread's sessions, most recently run first. */
export const sessionsFor = (paths: Paths, number: string): (SessionSummary & { state: ThreadState; commit: string })[] =>
  allStates(paths.threads)
    .filter(({ state }) => state.number === number)
    .flatMap(({ state }) =>
      Object.entries(state.sessions).map(([agent, s]) => ({ id: s.id, agent, workspace: state.workspace, lastRun: s.lastRun, state, commit: s.commit })),
    )
    .sort((a, b) => b.lastRun.localeCompare(a.lastRun));

/** A JSON array. The laptop's `achq resume` parses it (parseSessions in packages/cli/src/lib/remote/sessions.ts). */
export const formatSessions = (sessions: SessionSummary[]) =>
  JSON.stringify(sessions.map(({ id, agent, workspace, lastRun }) => ({ id, agent, workspace, lastRun })));

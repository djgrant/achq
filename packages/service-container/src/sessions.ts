import { SessionSummary } from "@achq/core/protocol";
import { z } from "zod";
import type { Paths } from "./paths.ts";
import { allStates, type ThreadState } from "./state.ts";

/** A thread's sessions, or every thread's without `number`, most recently run first. */
export const sessionsFor = (paths: Paths, number?: string): (SessionSummary & { state: ThreadState; commit: string })[] =>
  allStates(paths.threads)
    .filter(({ state }) => number === undefined || state.number === number)
    .flatMap(({ state }) =>
      Object.entries(state.sessions).map(([agent, s]) => ({ id: s.id, thread: state.number, agent, workspace: state.workspace, lastRun: s.lastRun, state, commit: s.commit })),
    )
    .sort((a, b) => b.lastRun.localeCompare(a.lastRun));

/** A JSON array of their summaries, only: the laptop's `achq container resume` parses it (parseSessions in packages/cli/src/lib/remote/sessions.ts). */
export const formatSessions = (sessions: SessionSummary[]) => JSON.stringify(z.array(SessionSummary).parse(sessions));

/*
 * What the runner writes as it goes, in local files on the volume rather than
 * a JsonStore: each thread's state, and the deliveries it has handled.
 */
import * as path from "node:path";
import type { ThreadRef } from "@achq/core";
import { disk } from "@achq/utils/disk";
import type { Paths } from "./features/layout.ts";

export type SessionState = {
  /** The session key it was started with; a different key means a fresh session. */
  key: string;
  id: string;
  lastMessage?: string;
  /** A hash of the opening post as last given to the session, to notice edits. */
  opening?: string;
  status: "idle" | "running" | "interrupted";
  /** ISO time the last run started. */
  lastRun: string;
  /** The config commit it last ran with, so `resume` opens it with the same agent config. */
  commit: string;
  /** The workspace whose worktree it runs in, so `resume` opens it there. */
  workspace: string;
};

export type ThreadState = {
  thread: ThreadRef;
  /** The channel source (e.g. the App's slug) the thread's events come through. */
  source: string;
  /** e.g. the issue number, for `sessions <n>` and `resume <n>`. */
  number: string;
  sessions: Record<string, SessionState>;
};

/**
 * The thread's state, or undefined before its first run. Files written before
 * sessions named their workspace have it once, on the thread; it's copied onto
 * each session here, so listing, `resume` and the runner all see it per session.
 */
export const readState = (file: string) => {
  const state = disk.readJsonSync<ThreadState & { workspace?: string }>(file);
  if (!state) return undefined;
  const { workspace, ...rest } = state;
  if (workspace !== undefined) for (const s of Object.values(rest.sessions)) s.workspace ??= workspace;
  return rest as ThreadState;
};

/** Atomic, so a crash mid-write leaves the previous state. */
export const writeState = (file: string, state: ThreadState) => disk.writeJsonSync(file, state, { pretty: true });

export const allStates = (dir: string) =>
  disk.listJsonNamesSync(dir).map((name) => {
    const file = disk.jsonFile(dir, name);
    return { file, state: readState(file)! };
  });

/** A thread's sessions, or every thread's without `number`, most recently run first. */
export const sessionsFor = (paths: Paths, number?: string) =>
  allStates(paths.threads)
    .filter(({ state }) => number === undefined || state.number === number)
    .flatMap(({ state }) =>
      Object.entries(state.sessions).map(([agent, s]) => ({ id: s.id, thread: state.number, agent, workspace: s.workspace, lastRun: s.lastRun, state, commit: s.commit })),
    )
    .sort((a, b) => b.lastRun.localeCompare(a.lastRun));

/** Records the delivery in `dir`; false if it was already handled. Persisted, so it holds across restarts. */
export const firstDelivery = (dir: string, delivery: string) => disk.createExclusive(path.join(dir, disk.safeFileName(delivery)));

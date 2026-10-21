import type { ThreadRef } from "@achq/core";
import { disk } from "@achq/utils/disk";

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
};

export type ThreadState = {
  thread: ThreadRef;
  /** The channel source (e.g. the App's slug) the thread's events come through. */
  source: string;
  /** e.g. the issue number, for `sessions <n>` and `resume <n>`. */
  number: string;
  /** The workspace that claimed the thread. It sticks. */
  workspace: string;
  sessions: Record<string, SessionState>;
};

/** The thread's state, or undefined before it's claimed. */
export const readState = (file: string): ThreadState | undefined => disk.readJsonSync<ThreadState>(file);

/** Atomic, so a crash mid-write leaves the previous state. */
export const writeState = (file: string, state: ThreadState) => disk.writeJsonSync(file, state, { pretty: true });

export const allStates = (dir: string): { file: string; state: ThreadState }[] =>
  disk.listJsonNamesSync(dir).map((name) => {
    const file = disk.jsonFile(dir, name);
    return { file, state: readState(file)! };
  });

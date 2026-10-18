import * as fs from "node:fs";
import * as path from "node:path";
import type { ThreadRef } from "@achq/core";

export type SessionState = {
  /** The session key it was started with; a different key means a fresh session. */
  key: string;
  id: string;
  /** The newest message already given to the session. */
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
  number?: string;
  /** The workspace that claimed the thread. It sticks. */
  workspace: string;
  sessions: Record<string, SessionState>;
};

export const readState = (file: string): ThreadState | undefined =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;

export const writeState = (file: string, state: ThreadState) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
};

export const allStates = (dir: string): { file: string; state: ThreadState }[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({ file: path.join(dir, f), state: readState(path.join(dir, f))! }))
    : [];

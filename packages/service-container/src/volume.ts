import * as path from "node:path";
import type { ThreadRef } from "@achq/core";
import { SessionSummary } from "@achq/core/protocol";
import { disk } from "@achq/utils/disk";
import { z } from "zod";

const UNSAFE_RUN = /[^A-Za-z0-9._-]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/**
 * A file-name-safe form of a thread or workspace id, e.g. `owner-repo-42` for
 * `owner/repo#42`. Not `disk.safeFileName`: these names are already on volumes,
 * and runs collapse to one dash so they stay readable.
 */
export const slug = (id: string) => id.replace(UNSAFE_RUN, "-").replace(EDGE_DASHES, "");

/** Everything lives on the volume, so a restart loses nothing. */
export const paths = (data: string) => ({
  data,
  /** HOME for agents and the runner; `~` in startup files. */
  home: path.join(data, "home"),
  mirror: path.join(data, "mirror.git"),
  config: (commit: string) => path.join(data, "config", commit),
  /** Each agent's own config directory (CLAUDE_CONFIG_DIR for Claude). */
  agent: (name: string) => path.join(data, "agents", name),
  policyProvider: (id: string) => path.join(data, id),
  /** The env (credentials, git identity) the last run gave agents, for `resume`. Mode 600. */
  agentEnv: path.join(data, "credentials", "agent-env.json"),
  threads: path.join(data, "threads"),
  thread: (threadKey: string) => path.join(data, "threads", `${slug(threadKey)}.json`),
  worktree: (workspace: string, threadKey: string) => path.join(data, "worktrees", workspace, slug(threadKey)),
  /** One run per thread per workspace: runs and `resume` take this lock. */
  lock: (workspace: string, threadKey: string) => path.join(data, "locks", workspace, slug(threadKey)),
  deliveries: path.join(data, "deliveries"),
});

export type Paths = ReturnType<typeof paths>;

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

/**
 * A JSON array of their summaries, only: the laptop's `achq container resume` parses it (parseSessions in packages/core/src/wire/commands.ts).
 * SessionSummary is loose, for reading what another version printed, so the summary's own shape strips the rest.
 */
const summaries = z.array(z.object(SessionSummary.shape));
export const formatSessions = (sessions: SessionSummary[]) => JSON.stringify(summaries.parse(sessions));

/** Records the delivery in `dir`; false if it was already handled. Persisted, so it holds across restarts. */
export const firstDelivery = (dir: string, delivery: string) => disk.createExclusive(path.join(dir, disk.safeFileName(delivery)));

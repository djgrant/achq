import type { Agent } from "../model/resources.ts";
import type { ThreadRef } from "./channel.ts";

export type RunContext = {
  thread: ThreadRef;
  /** The workspace's worktree. */
  cwd: string;
  /** This agent's own config directory. */
  configDir: string;
  /** Already without the container's private variables. */
  env: Record<string, string>;
  prompt: string;
  /** Resume an existing session, or start a new one with this ID. */
  session: { resume: string } | { new: string };
  signal: AbortSignal;
  log: (line: string) => void;
};

export type RunResult = { reply: string; error?: string };

/** The runtime side of an Agent resource. */
export interface AgentRuntime {
  readonly name: string;
  /** A hash of everything in the cached prefix. A different key means a fresh session. */
  sessionKey(): Promise<string>;
  /** Writes the agent's config into its own config directory. */
  configure(configDir: string): Promise<void>;
  run(context: RunContext): Promise<RunResult>;
  /** The command that opens a session interactively, for `achq resume`. */
  resumeCommand(session: string, configDir: string): { argv: string[]; env: Record<string, string> };
}

/** What the container gives an agent's runtime, once per config commit. */
export type RuntimeContext = {
  /** A file in `.achq/` at the config's commit, refusing paths that leave it. */
  readFile(relative: string): string;
  /** Startup files' contents by target path. A string names a file in `.achq/`. Anything else is written as JSON. */
  resolveFiles(files: Record<string, unknown> | undefined): Record<string, string>;
  /** HOME, where `~` in startup files points. */
  home: string;
  /** achq's runner prompt, always applied before the repo's. */
  runnerPrompt: string;
  /** The container's startup files' contents, by target path. Part of every session key. */
  containerFiles: Record<string, string>;
  /** Executables, e.g. `{ claude: "/usr/local/bin/claude" }`. */
  bin: Record<string, string>;
};

export type RuntimeFactory = (agent: Agent, ctx: RuntimeContext) => AgentRuntime;

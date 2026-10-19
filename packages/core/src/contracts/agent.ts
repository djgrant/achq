import type { Agent } from "../resources/config.ts";
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
  /** The container's environment, without its private variables. A runtime reads its own settings from it, e.g. which binary to run. */
  env: Record<string, string | undefined>;
};

export type RuntimeFactory = (agent: Agent, ctx: RuntimeContext) => AgentRuntime;

/** An agent runtime package, e.g. Claude. Its id is its agents' `runtime`. */
export interface AgentProvider {
  readonly id: string;
  /** What every container needs for it. `achq up` reads these from your environment. */
  readonly containerEnv: { name: string; hint?: string }[];
  runtime: RuntimeFactory;
}

import type { Agent } from "../resources/config.ts";
import type { ThreadRef } from "../model/threads.ts";
import type { Vars } from "@achq/utils/env";

export type RunContext = {
  thread: ThreadRef;
  /** The workspace's worktree. */
  cwd: string;
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

/**
 * One agent, set up in a container to run on its runtime: it drives the
 * runtime's CLI, writing the agent's config, running a turn and giving the
 * command that resumes a session. Its provider's `driver` makes it.
 */
export interface AgentDriver {
  readonly name: string;
  /** A hash of everything in the cached prefix. A different key means a fresh session. */
  sessionKey(): Promise<string>;
  configure(configDir: string): Promise<void>;
  run(context: RunContext): Promise<RunResult>;
  /** The command that opens a session interactively, for `achq container resume`. */
  resumeCommand(session: string, configDir: string): { argv: string[]; env: Record<string, string> };
}

/** What the container gives an agent's driver, once per config commit. */
export type DriverContext = {
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
  /** The container's environment, without its private variables. A driver reads its runtime's settings from it, e.g. which binary to run. */
  env: Vars;
};

export type DriverFactory = (agent: Agent, ctx: DriverContext) => AgentDriver;

/** An agent runtime, e.g. Claude Code, as a plugin provides it. Its id is what its agents' `runtime` names, and the infra's `AgentRuntime` declares it. */
export interface AgentProvider {
  readonly id: string;
  /** What every container needs for it. `achq infra up` reads these from your environment. */
  readonly containerEnv: { name: string; hint?: string }[];
  driver: DriverFactory;
}

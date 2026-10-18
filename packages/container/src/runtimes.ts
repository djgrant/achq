// Agent kinds → their runtimes. A repo's Agent resource says what it is; the
// container turns it into something that runs.
import { claudeRuntime } from "@achq/claude/runtime";
import type { Claude } from "@achq/claude";
import type { Agent } from "@achq/core";
import type { AgentRuntime } from "@achq/core";

export type RuntimeContext = {
  /** The `.achq/` directory at the config's commit; agents' paths are relative to it. */
  root: string;
  /** HOME, where `~` in startup files points. */
  home: string;
  /** achq's runner prompt, always applied before the repo's. */
  runnerPrompt: string;
  /** The container's startup files' contents, by target path: part of every session key. */
  containerFiles: Record<string, string>;
  /** Executables, e.g. `{ claude: "/usr/local/bin/claude" }`. */
  bin: Record<string, string>;
};

export type RuntimeFactory = (agent: Agent, ctx: RuntimeContext) => AgentRuntime;

export const defaultRuntimes: Record<string, RuntimeFactory> = {
  claude: (agent, ctx) => claudeRuntime(agent as Claude, ctx),
};

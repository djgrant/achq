import { Agent as CoreAgent } from "@achq/core";
import { RUNTIME } from "../lib/constants.ts";
import { PLUGIN } from "../plugin.ts";

export type AgentConfig = {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The repo's system prompt, a path relative to `.achq/`. Appended after achq's runner prompt. */
  systemPrompt?: string;
  /** Written to the agent's `settings.json`. Can be computed in code. */
  settings?: Record<string, unknown>;
  /** Startup files for this agent. A key under `~/.claude/` goes in the agent's own config directory. */
  files?: Record<string, string | Record<string, unknown>>;
};

/** An agent that runs Claude Code: `new claude.Agent("coder", { model, effort, systemPrompt })`. */
export class Agent extends CoreAgent<AgentConfig> {
  readonly plugin = PLUGIN;
  readonly runtime = RUNTIME;
}

import { Agent } from "@achq/core";

export type ClaudeConfig = {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The repo's system prompt, a path relative to `.achq/`. Appended after achq's runner prompt. */
  systemPrompt?: string;
  /** Written to the agent's `settings.json`. Can be computed in code. */
  settings?: Record<string, unknown>;
  /** Startup files for this agent. A key under `~/.claude/` goes in the agent's own config directory. */
  files?: Record<string, string | Record<string, unknown>>;
};

export class Claude extends Agent<ClaudeConfig> {
  readonly agentKind = "claude";
}

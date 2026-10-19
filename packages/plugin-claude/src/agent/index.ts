import type { AgentProvider } from "@achq/core";
import { ClaudeAgentProvider } from "./provider.ts";

/** Claude Code, run in the container with the Claude token every container gets. */
export const claudeAgentProvider: AgentProvider = new ClaudeAgentProvider();

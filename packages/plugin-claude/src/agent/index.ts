import type { AgentProvider } from "@achq/core";
import { ClaudeAgentProvider } from "./provider.ts";

export const claudeAgentProvider: AgentProvider = new ClaudeAgentProvider();

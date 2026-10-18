import type { Claude } from "@achq/claude";
import { claudeRuntime } from "@achq/claude/runtime";
import type { RuntimeFactory } from "@achq/core";

export const defaultRuntimes: Record<string, RuntimeFactory> = {
  claude: (agent, ctx) => claudeRuntime(agent as Claude, ctx),
};

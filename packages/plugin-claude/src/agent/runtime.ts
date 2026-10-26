import { AgentRuntime as CoreAgentRuntime } from "@achq/core";
import { PLUGIN } from "../plugin.ts";
import { claudeAgentProvider } from "./index.ts";

/** Claude Code, for the infra's containers: `new claude.AgentRuntime("claude")`. Every container gets CLAUDE_CODE_OAUTH_TOKEN from your environment. */
export class AgentRuntime extends CoreAgentRuntime {
  readonly plugin = PLUGIN;
  readonly provider = claudeAgentProvider;
}

import type { AgentProvider } from "@achq/core";
import { AGENT_KIND, TOKEN_ENV } from "../constants.ts";
import type { Claude } from "../resources.ts";
import { claudeRuntime } from "./runtime.ts";

export const claudeAgent: AgentProvider = {
  id: AGENT_KIND,
  containerEnv: [{ name: TOKEN_ENV, hint: "Run `claude setup-token`." }],
  runtime: (agent, ctx) => claudeRuntime(agent as Claude, ctx),
};

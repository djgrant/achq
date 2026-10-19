import type { AgentProvider } from "@achq/core";
import { RUNTIME } from "../lib/constants.ts";
import type { Claude } from "../resources/claude.ts";
import { TOKEN_ENV } from "./constants.ts";
import { claudeRuntime } from "./runtime.ts";

export const claudeAgent: AgentProvider = {
  id: RUNTIME,
  containerEnv: [{ name: TOKEN_ENV, hint: "Run `claude setup-token`." }],
  runtime: (agent, ctx) => claudeRuntime(agent as Claude, ctx),
};

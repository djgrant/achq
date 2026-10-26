import type { Providers } from "@achq/core";
import { claudeAgentProvider } from "./agent/index.ts";

/** What containers load from this package. */
export const providers: Providers = { agents: [claudeAgentProvider] };

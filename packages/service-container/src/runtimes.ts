import type { RuntimeFactory } from "@achq/core";
import { AGENT_PROVIDERS } from "achq/registry";

/** Each agent runtime achq knows, by its agents' `runtime`. */
export const defaultRuntimes: Record<string, RuntimeFactory> = Object.fromEntries(AGENT_PROVIDERS.map((a) => [a.id, a.runtime]));

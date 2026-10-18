import type { RuntimeFactory } from "@achq/core";
import { AGENTS } from "achq/registry";

/** Each agent runtime achq knows, by its agents' `agentKind`. */
export const defaultRuntimes: Record<string, RuntimeFactory> = Object.fromEntries(AGENTS.map((a) => [a.id, a.runtime]));

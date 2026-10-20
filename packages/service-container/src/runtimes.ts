import type { RuntimeFactory } from "@achq/core";
import { AGENT_PROVIDERS } from "achq/registry";

export const defaultRuntimes: Record<string, RuntimeFactory> = Object.fromEntries(AGENT_PROVIDERS.map((a) => [a.id, a.runtime]));

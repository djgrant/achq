import { DEFAULT_MODEL, PERSISTED_EFFORT } from "../constants.ts";
import type { ClaudeConfig } from "../resources.ts";

/** `settings.json`: achq's defaults, then the repo's settings on top. */
export const claudeSettings = (config: ClaudeConfig): Record<string, unknown> => ({
  model: config.model ?? DEFAULT_MODEL,
  ...(config.effort && PERSISTED_EFFORT.has(config.effort) && { effortLevel: config.effort }),
  attribution: { commit: "", pr: "" },
  ...config.settings,
});

/** Flags for config that settings.json can't hold. */
export const effortFlags = (config: ClaudeConfig) => (config.effort === "max" ? ["--effort", "max"] : []);

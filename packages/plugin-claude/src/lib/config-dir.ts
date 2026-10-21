import * as fs from "node:fs";
import * as path from "node:path";
import { disk } from "@achq/utils/disk";
import type { AgentConfig } from "../agent/resource.ts";
import { CLAUDE_HOME, CLAUDE_JSON, DEFAULT_MODEL, PERSISTED_EFFORT } from "./constants.ts";

const HOME_PREFIX = "~/";

/** `~/.claude/…` goes in the agent's own config directory; `~/…` and relative paths under `home`; absolute paths as they are. */
export const resolveStartupPath = (key: string, home: string, configDir: string) => {
  if (key === CLAUDE_HOME || key.startsWith(`${CLAUDE_HOME}/`)) return path.join(configDir, key.slice(CLAUDE_HOME.length));
  if (key.startsWith(HOME_PREFIX)) return path.join(home, key.slice(HOME_PREFIX.length));
  return path.isAbsolute(key) ? key : path.join(home, key);
};

/** The parts of `.claude.json` achq sets. Claude Code owns the rest. */
export type ClaudeJson = {
  hasCompletedOnboarding?: boolean;
  theme?: string;
  projects?: Record<string, { hasTrustDialogAccepted?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
};

/** Changes `.claude.json` in place, keeping what Claude Code wrote. */
export const updateClaudeJson = (configDir: string, fn: (config: ClaudeJson) => void) => {
  disk.updateJsonSync<ClaudeJson>(path.join(configDir, CLAUDE_JSON), {}, fn, { pretty: true });
};

export const transcriptExists = (configDir: string, session: string) => {
  const projects = path.join(configDir, "projects");
  return fs.existsSync(projects) && new Bun.Glob(`*/${session}.jsonl`).scanSync(projects).next().done === false;
};

/** `settings.json`: achq's defaults, then the repo's settings on top. */
export const claudeSettings = (config: AgentConfig) => ({
  model: config.model ?? DEFAULT_MODEL,
  ...(config.effort && PERSISTED_EFFORT.has(config.effort) && { effortLevel: config.effort }),
  attribution: { commit: "", pr: "" },
  ...config.settings,
});

/** Flags for config that settings.json can't hold. */
export const effortFlags = (config: AgentConfig) => (config.effort === "max" ? ["--effort", "max"] : []);

// An agent's own config directory: its startup files, `settings.json` and
// `.claude.json`, and its session transcripts.
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agent/resource.ts";
import { CLAUDE_HOME, CLAUDE_JSON, DEFAULT_MODEL, PERSISTED_EFFORT } from "./constants.ts";

/** `~/.claude/…` goes in the agent's own config directory. Other files go where the container would put them. */
export const writeFiles = (resolved: Record<string, string>, home: string, configDir: string) => {
  for (const [key, content] of Object.entries(resolved)) {
    const file =
      key === CLAUDE_HOME || key.startsWith(`${CLAUDE_HOME}/`)
        ? path.join(configDir, key.slice(CLAUDE_HOME.length))
        : key.startsWith("~/")
          ? path.join(home, key.slice(2))
          : path.isAbsolute(key)
            ? key
            : path.join(home, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};

export const updateClaudeJson = (configDir: string, fn: (config: any) => void) => {
  const file = path.join(configDir, CLAUDE_JSON);
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fn(config);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
};

export const transcriptExists = (configDir: string, session: string) => {
  const projects = path.join(configDir, "projects");
  return fs.existsSync(projects) && new Bun.Glob(`*/${session}.jsonl`).scanSync(projects).next().done === false;
};

/** `settings.json`: achq's defaults, then the repo's settings on top. */
export const claudeSettings = (config: AgentConfig): Record<string, unknown> => ({
  model: config.model ?? DEFAULT_MODEL,
  ...(config.effort && PERSISTED_EFFORT.has(config.effort) && { effortLevel: config.effort }),
  attribution: { commit: "", pr: "" },
  ...config.settings,
});

/** Flags for config that settings.json can't hold. */
export const effortFlags = (config: AgentConfig) => (config.effort === "max" ? ["--effort", "max"] : []);

/** The `AgentProvider` id, and Claude agents' `runtime`. */
export const RUNTIME = "claude";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** What every container needs: Claude Code's login. */
export const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** Which `claude` binary to run, when it isn't on PATH. */
export const BIN_ENV = "ACHQ_CLAUDE_BIN";

/**
 * The agent only sees the trusted context the runner gives it. These commands
 * could read anyone's thread content, so they're denied. Commenting is denied
 * because the runner posts the reply.
 */
export const DENIED = ["Bash(gh issue view:*)", "Bash(gh issue list:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)", "Bash(gh search:*)"];

/** Effort levels `settings.json` can persist. `max` is per session only, so it's a flag. */
export const PERSISTED_EFFORT = new Set(["low", "medium", "high", "xhigh"]);

/** In the agent's config directory. */
export const SYSTEM_PROMPT_FILE = "achq-system-prompt.md";
export const SETTINGS_FILE = "settings.json";
export const CLAUDE_JSON = ".claude.json";

/** Startup files under this go in the agent's own config directory. */
export const CLAUDE_HOME = "~/.claude";

/** Set for every run, so Claude never updates itself mid-session. */
export const CLAUDE_ENV = { DISABLE_AUTOUPDATER: "1" };

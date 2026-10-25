# `@achq/claude`

`@achq/claude` provides the Claude Code `Agent` resource for `.achq/config.ts` and the runtime adapter that executes `claude` inside outpost containers.

## Agent

Configure a Claude Code agent for an outpost:

```ts [.achq/config.ts]
import * as claude from "achq/claude";

const coder = new claude.Agent("coder", {
  model: "claude-opus-5-5",
  effort: "high",
  systemPrompt: "./prompts/coder.md", // <-- relative to .achq/
  settings: { cleanupPeriodDays: 30 },
  files: {
    "~/.claude/CLAUDE.md": "./CLAUDE.md",
  },
});
```

| Option | Effect in outpost container |
| --- | --- |
| `model` | Written to `/data/agents/<name>/settings.json` (and passed via `--model`) |
| `effort` | Passed as `--effort <low \| medium \| high \| xhigh \| max>` |
| `systemPrompt` | Appended to runner prompt at `/data/agents/<name>/system-prompt.md` |
| `settings` | Merged into `/data/agents/<name>/settings.json` at runtime |
| `files` | `~/.claude/*` writes to `/data/agents/<name>/`; other `~/*` writes to `/data/home/` |

## Runtime invocation

Each agent runs with `CLAUDE_CONFIG_DIR=/data/agents/<name>`:

| Mode | Invocation |
| --- | --- |
| **Channel trigger (headless)** | `claude -p --output-format=stream-json --dangerously-skip-permissions --session-id=<uuid>` (or `--resume=<uuid>`) |
| **`achq container resume` (TUI)** | `claude --append-system-prompt-file=... --resume=<uuid>` inside the thread's worktree |

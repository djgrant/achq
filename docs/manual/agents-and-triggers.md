# Agents & Triggers

Configure an agent persona and choose which channel events wake it:

```ts [.achq/config.ts]
const coder = new claude.Agent("coder", {
  model: "claude-opus-5-5",
  effort: "high",
  systemPrompt: "./prompts/coder.md",
});

new Trigger("mention", {
  event: channel.issueComment({ mention: "@claude" }),
  agent: coder,
});
```

`Agent` configures an agent runtime (model, effort, and system prompt), and `Trigger` runs that agent whenever a matching channel event fires. Follow-up triggers on the same issue automatically resume `coder`'s conversation session.

## Event selectors

Narrow when a trigger fires by issue action, label, or mention:

```ts [.achq/config.ts]
channel.issue({ actions: ["opened"], labels: ["bug"] })
channel.issueComment({ actions: ["created", "edited"], mention: "@claude" })
```

| Selector | Default `actions` | Supported `actions` | Filters |
| --- | --- | --- | --- |
| `channel.issue(opts?)` | `["opened"]` | `"opened"`, `"edited"`, `"reopened"`, `"labeled"` | `mention`, `labels` |
| `channel.issueComment(opts?)` | `["created"]` | `"created"`, `"edited"` | `mention`, `labels` |

When `actions` includes `"edited"`, the trigger fires only if the edit newly added the `@mention`.

## Multiple agents on one thread

Specialize agents by cost and capability for different tasks:

```ts [.achq/config.ts]
const triage = new claude.Agent("triage", {
  model: "claude-haiku-5-5",
  systemPrompt: "./prompts/triage.md",
});

const coder = new claude.Agent("coder", {
  model: "claude-opus-5-5",
  systemPrompt: "./prompts/coder.md",
});
```

Bind each agent to its stage of the issue lifecycle:

```ts [.achq/config.ts]
new Trigger("on-open", {
  event: channel.issue({ actions: ["opened"] }), // <-- 1. triage investigates new issues
  agent: triage,
});

new Trigger("on-mention", {
  event: channel.issueComment({ mention: "@claude" }), // <-- 2. coder implements on @claude
  agent: coder,
});
```

Both `triage` and `coder` run inside the same `issue-42` git worktree while keeping their own separate session transcripts:

| Path | Scope | Holds |
| --- | --- | --- |
| `/data/worktrees/<workspace>/<thread>` | Shared per thread | Git checkout where agents read and write repo files |
| `/data/agents/<agent>/` | Isolated per `Agent` | Agent settings, prompts, and session transcripts |

# Workspaces & Threads

Isolate concurrent issue threads so agents never overwrite each other's work:

```ts [.achq/config.ts]
new Workspace("issues", {
  container: dev,
  threads: channel.issues,
  branch: "issue-{number}", // <-- issue #42 checks out branch `issue-42`
  base: "main",             // <-- branched from `origin/main`
});
```

A `Workspace` gives each matching thread its own persistent git worktree inside `dev`:

```text
Issue #42 ──► /data/worktrees/issues/acme-webapp-42  (branch `issue-42`)
Issue #43 ──► /data/worktrees/issues/acme-webapp-43  (branch `issue-43`)
```

## Filtering threads

Route specific issues to a dedicated branch or container before falling back to the default workspace:

```ts [.achq/config.ts]
new Workspace("docs", {
  container: dev,
  threads: channel.issues.where({ labels: ["docs"] }), // <-- 1. checked first
  branch: "docs-{number}",
  base: "docs",
});

new Workspace("issues", {
  container: dev,
  threads: channel.issues, // <-- 2. fallback for all other issues
  branch: "issue-{number}",
  base: "main",
});
```

Workspaces evaluate in declaration order and lock in their claim for the lifetime of the thread:

| Rule | Behavior |
| --- | --- |
| **1. Declaration order** | New issues match the first `Workspace` whose `threads` selector passes |
| **2. Sticky claims** | Once claimed, an issue stays in its workspace even if labels change later |

## Multiple containers

Run separate environments in parallel on the same issue:

```ts [.achq/config.ts]
new Workspace("main-linux", {
  container: linux,
  threads: channel.issues,
  branch: "linux-{number}", // <-- distinct branch per container
  base: "main",
});

new Workspace("main-sec", {
  container: sec,
  threads: channel.issues,
  branch: "sec-{number}",
  base: "main",
});
```

One container claims each issue at most once, while workspaces in separate containers (`linux` and `sec`) claim the same issue independently and run in parallel.

## Concurrency

Each worktree runs at most one agent at a time:

| Event on issue `#42` | What happens |
| --- | --- |
| **1. Trigger arrives (idle)** | Starts the agent in the `issue-42` worktree |
| **2. Trigger arrives (busy)** | Replies `"An agent is working on this thread..."` immediately |
| **3. Next trigger after run finishes** | Includes all intermediate comments from step 2 |

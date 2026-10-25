# Introduction

Agent Communications Headquarters (ACHQ) is a SIGINT hub to manage your agents:

- **Listens** for messages on your communication platforms (GitHub issues, Linear, etc.)
- **Dispatches** agents into remote outposts (Cloudflare Containers, Railway, E2B, etc.)
- **Connects** you to remote agents directly over a secure line (SSH, Tailscale, etc.)

```text
GitHub Issue #42 ──► ACHQ Router ──► Outpost Container (branch `issue-42`)
                                              ▲
                                              └── achq container resume 42
```

| Layer | File | Owns |
| --- | --- | --- |
| **ACHQ** | `achq.infra.ts` | Central `Router`, `Deployer`, and `Channel` webhooks |
| **Outpost** | `.achq/config.ts` | Per-repo `Container`, `Workspace`, `Agent`, and `Trigger` |

## ACHQ (`achq.infra.ts`)

Stand up a central control plane once for your organization:

```ts [achq.infra.ts]
const router = new cloudflare.Router("router", { project: "acme-agents" });

new cloudflare.Deployer("deployer", {
  router,
  owners: ["acme"],
});

new github.Channel("github", {
  name: "acme-agents",
  org: "acme",
  router,
});
```

One ACHQ instance serves all of your repositories: the `Channel` sends webhooks to the `Router`, and the `Deployer` builds outpost containers when a repository subscribes. See [Declaring Infra](./infra.md).

## Outpost (`.achq/config.ts`)

### Workspaces

Give each issue thread an isolated environment to work in:

```ts [.achq/config.ts]
const channel = github.Channel.get("acme-agents");
const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });

new Workspace("issues", {
  container: dev,
  threads: channel.issues,
  branch: "issue-{number}", // <-- issue #42 works on branch `issue-42`
  base: "main",
});
```

A `Workspace` routes issue threads into `dev` and gives each issue its own git branch from `main`.

### Triggers

Wake an agent when someone mentions it on an issue:

```ts [.achq/config.ts]
const coder = new claude.Agent("coder", { model: "claude-opus-5-5" });

new Trigger("mention", {
  event: channel.issueComment({ mention: "@claude" }),
  agent: coder,
});
```

Commenting `@claude` on issue `#42` runs `coder` on branch `issue-42` and posts its reply back to the issue. See [Declaring Outposts](./outposts.md).

### Terminal handoff

Take over a running issue session from your local terminal:

```sh
achq container resume 42
```

Opens an SSH connection to `dev` and attaches your local terminal directly to issue `#42`'s branch and Claude session. See [Threads & Sessions](./github-usage.md).

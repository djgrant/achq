# Introduction

Agent Communications Headquarters (ACHQ) is a SIGINT hub to manage your agents:

- **Listens** to messages on your communication channels (GitHub issues, Linear, etc.)
- **Dispatches** agents into remote outposts (Cloudflare Containers, Railway, E2B, etc.)
- **Connects** you directly to remote agents over a secure line (SSH, Tailscale, etc.)


## ACHQ

Stand up a central ACHQ instance your organisation to serve all of your outposts.

```ts [achq.infra.ts]
const router = new cloudflare.Router("router", { project: "acme-agents" });

new cloudflare.Deployer("deployer", {
  router,
  owners: ["acme"],
});

new github.Channel("github", {
  name: "acme-agents-github-app",
  org: "acme",
  router,
});
```

The `Deployer`, provisions agent containers when a new outpost comes online (e.g. a Github app is installed on your repo).

The `Channel` (in this case, a Github app) sends webhooks to the `Router`. 

The `Router` processes and forwards events to the outpost containers.


## Outposts

### Workspaces

Give each issue thread an isolated environment to work in:

```ts [.achq/config.ts]
const channel = github.Channel.get("acme-agents-github-app"); // <-- that's the one you defined in achq.infra.ts

const dev = new Container("dev", { 
  image: "./Dockerfile", 
  policies: [code]
});

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

# Declaring Outposts

Each repository defines its own outpost in `.achq/`:

```text
.achq/
├── config.ts          # Containers, Policies, Workspaces, Agents, and Triggers
├── Dockerfile         # container image definition
└── prompts/
    └── system.md      # prompt files referenced by Agents
```

Within `config.ts`, workspaces decide where a thread lives and triggers decide who runs:

```text
                ┌──► Workspace ("issues") ──► Container ("dev") ◄── Policy ("code")
Channel         │      (where the thread's branch lives)
("acme-agents")─┤
                └──► Trigger ("mention") ───► Agent ("coder")
                       (when and who runs in that branch)
```

## Containers & policies

Define the remote machine and the credentials it is allowed to use:

```ts [.achq/config.ts]
const channel = github.Channel.get("acme-agents");

const code = new github.Policy("code", {
  channel,
  permissions: { contents: "write", issues: "write", pull_requests: "write" },
});
const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });
```

`dev` is the remote container built from `.achq/Dockerfile`, and `code` grants it GitHub permissions to push branches and comment on issues. See [Containers & Policies](./containers.md).

## Workspaces

Give each issue thread its own persistent git branch inside that container:

```ts [.achq/config.ts]
new Workspace("issues", {
  container: dev,
  threads: channel.issues,
  branch: "issue-{number}", // <-- issue #42 works on branch `issue-42`
  base: "main",
});
```

A `Workspace` routes issue threads from `channel` into `dev` and checks out a dedicated branch from `main` for each issue. See [Workspaces & Threads](./workspaces.md).

## Agents & triggers

Wake an agent inside the thread's workspace when an event fires:

```ts [.achq/config.ts]
const coder = new claude.Agent("coder", {
  model: "claude-opus-5-5",
  systemPrompt: "./prompts/system.md",
});

new Trigger("mention", {
  event: channel.issueComment({ mention: "@claude" }),
  agent: coder,
});
```

A `Trigger` runs `coder` whenever a matching event fires on a thread, executing inside whichever `Workspace` claimed that thread. See [Agents & Triggers](./agents-and-triggers.md).

## Subscribing & deploys

Subscribe the repository to build and activate its outpost:

```sh
achq repo install   # subscribe the repo and wait for the initial container build
achq repo status    # check build status
```

Once subscribed, pushing changes to `.achq/` on the default branch automatically updates the outpost:

| Change in `.achq/` | What updates |
| --- | --- |
| `Dockerfile` or `Container` | Builds a new container image |
| `Workspace`, `Trigger`, `Agent`, `Policy`, or prompts | Takes effect on the next run (no image rebuild) |

# The abstract program

The infra and a repo's config written with only the primitives, nothing platform-specific. Not valid code: a way to see the model.

```ts
// ── Infra ──────────────────────────────────────────────

const router = new Router("router", {
  host: new RouterHost({ … }),               // public, always on, with a volume
});

const deployer = new Deployer("deployer", {
  router,                                    // wakes the deployer and forwards install and push events to it
  containerHost: new ContainerHost({ … }),   // where it puts containers
  owners: [ … ],
});

// One service can provide both of these (a GitHub App does). Separately:
new Channel("notation", { router });               // events in to the router, replies out to threads
new AccessProvider("notation", { router, deployer });
// The router mints credentials with it; its installations decide which repos the deployer serves.
```

```ts
// ── Repo ───────────────────────────────────────────────

const channel = Channel.get("notation");
const access = AccessProvider.get("notation");

const code = new Policy("code", { provider: access, scope: { … } });

const dev = new Container("dev", {
  image: "./Dockerfile",
  policies: [code],
  files: { … },
});

new Workspace("docs", {
  container: dev,
  threads: new ThreadSelector(channel, { labels: ["docs"] }),
  branch: "docs-{number}",
  base: "docs",
});
new Workspace("issues", {
  container: dev,
  threads: new ThreadSelector(channel, {}),
  branch: "issue-{number}",
  base: "main",
});

const coder = new Agent("coder", { … });
const triage = new Agent("triage", { … });

new Trigger("mention", { event: new EventSelector(channel, { type: "comment", mention: "@claude" }), agent: coder });
new Trigger("triage", { event: new EventSelector(channel, { type: "thread.opened" }), agent: triage });
```

## What it shows

- The infra wires services together: router, deployer, hosts, channels and access providers. A repo never mentions the router, deployer or host.
- A repo has two inputs from outside, a channel and an access provider, both adopted by name. It declares everything else itself.
- Policies attach to the container, selectors to workspaces and triggers. Access is decided per container; events per workspace and trigger.
- The access provider's installations drive deployment: that's its binding to the deployer. The channel only binds to the router.
- The repo uses the channel twice, for threads and for events. A workspace and a trigger meet when they use the same channel; the router links them through the event's thread.

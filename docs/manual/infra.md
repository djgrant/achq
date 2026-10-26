# Declaring Infra

Stand up a central control plane to serve all of your repositories:

```ts [achq.infra.ts]
import { achq } from "@achq/core";
import * as cloudflare from "@achq/cloudflare/infra";
import * as github from "@achq/github/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "acme-agents" });

  new cloudflare.Deployer("deployer", {
    router,
    owners: ["acme"], // <-- only builds outposts for repos owned by "acme"
  });

  new github.Channel("github", {
    name: "acme-agents",
    org: "acme",
    router,
  });
});
```

Each repository then declares its own outpost in [`.achq/config.ts`](./outposts.md), while `achq.infra.ts` owns the shared services:

| Component | Exposure | Role |
| --- | --- | --- |
| `Router` | Public, always on | Receives channel webhooks, routes events, mints short-lived container tokens |
| `Deployer` | Private, sleeps when idle | Builds outpost containers for repositories matching `owners` |
| `Channel` | External platform | Creates the GitHub App and points its webhook at `Router` |

## Deploying & updating

Reconcile your live cloud resources and subscribed outposts with `achq.infra.ts`:

```sh
achq infra up --dry-run   # preview diff without modifying resources
achq infra up             # apply infra changes and sync subscribed outposts
achq infra up --prune     # delete sleeping containers for unsubscribed repos
```

| Outpost state | Default (`achq infra up`) | With `--prune` |
| --- | --- | --- |
| **Subscribed** | Built and routed | Built and routed |
| **Unsubscribed or removed** | Unrouted; container + `/data` kept asleep | Container + `/data` permanently deleted |

## Multiple channels

Connect multiple organizations or personal accounts to the same control plane:

```ts [achq.infra.ts]
new github.Channel("org", {
  name: "acme-agents",
  org: "acme",
  router,
});

new github.Channel("personal", {
  name: "alice-agents", // <-- omit `org` for a personal GitHub App
  router,
});
```

Both channels route events through the shared `Router` and `Deployer`.

## Tearing down

Decommission the control plane and all of its outposts:

```sh
achq infra down --dry-run
achq infra down
```

Destroys all outpost containers first, then tears down `Deployer` and `Router`, and opens browser settings for protected resources (GitHub Apps and API tokens).

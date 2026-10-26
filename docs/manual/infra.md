# Declaring Infra

Stand up a central control plane to serve all of your repositories:

```ts [achq.infra.ts]
import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as cloudflare from "@achq/cloudflare/infra";
import * as github from "@achq/github/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "acme-agents" });

  new cloudflare.Deployer("deployer", {
    router,
    owners: ["acme"], // <-- only builds outposts for repos owned by "acme"
  });

  new github.CodeHost("github"); // <-- where the repos live

  new github.Channel("github", {
    name: "acme-agents",
    org: "acme",
    router,
  });

  new claude.AgentRuntime("claude"); // <-- what outposts' agents run on
});
```

Each repository then declares its own outpost in [`.achq/config.ts`](./outposts.md), while `achq.infra.ts` owns the shared services:

| Component | Exposure | Role |
| --- | --- | --- |
| `Router` | Public, always on | Receives channel webhooks, routes events, mints short-lived container tokens |
| `Deployer` | Private, sleeps when idle | Builds outpost containers for repositories matching `owners` |
| `CodeHost` | External platform | Where the repositories live; an infra has one |
| `Channel` | External platform | Creates the GitHub App and points its webhook at `Router` |
| `AgentRuntime` | Every outpost | An agent runtime outposts can run, with what it needs from your environment, e.g. `CLAUDE_CODE_OAUTH_TOKEN` |

Each resource carries the package it came from and its version. `achq infra up` gives the router and deployer the packages they load, and every outpost container the channels', policies' and runtimes', and each installs them from npm when it starts. Upgrading a plugin in the infrastructure repository and running `achq infra up` redeploys what loads it. An outpost agent whose runtime the infra doesn't declare fails its deploy.

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

## Writing a plugin

A plugin is an npm package that implements `@achq/core`'s contracts and declares resources that carry it. It needs three things:

```ts [src/plugin.ts]
import type { Plugin } from "@achq/core";
import pkg from "../package.json" with { type: "json" };

export const PLUGIN: Plugin = { package: pkg.name, version: pkg.version };
```

```ts [src/providers.ts — exported as "./providers"]
import type { Providers } from "@achq/core";

export const providers: Providers = {
  channels: [slackChannelProvider], // <-- or policies, containers, codeHosts, agents
};
```

```ts [src/infra.ts]
import { ManagedResource } from "@achq/core";
import { PLUGIN } from "./plugin.ts";

export class Channel extends ManagedResource</* … */> {
  readonly plugin = PLUGIN; // <-- which package the processes that use it install
  readonly kind = "slack-channel";
  readonly role = "channel"; // <-- loaded by the router, deployer and outposts
  // …
}
```

Take `@achq/core` and `@achq/utils` as peer dependencies, so the plugin uses the core of whatever installs it. Publish it, add it to the infrastructure repository, and declare its resources in `achq.infra.ts`.

## Tearing down

Decommission the control plane and all of its outposts:

```sh
achq infra down --dry-run
achq infra down
```

Destroys all outpost containers first, then tears down `Deployer` and `Router`, and opens browser settings for protected resources (GitHub Apps and API tokens).

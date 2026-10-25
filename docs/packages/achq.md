# `achq`

`achq` is the single package imported by both ACHQ infrastructure configs (`achq.infra.ts`) and repository outpost configs (`.achq/config.ts`).

| Import path | Used in | Exports |
| --- | --- | --- |
| `achq` | `.achq/config.ts` | `Container`, `Policy`, `Workspace`, `Agent`, `Trigger`, `EventSelector`, `ThreadSelector` |
| `achq/infra` | `achq.infra.ts` | `achq`, `Router`, `Deployer`, `cloudflare`, `railway`, `github` |
| `achq/github` | `.achq/config.ts` | [`@achq/github`](./github.md) (`Channel.get`, `Policy`, thread & event selectors) |
| `achq/claude` | `.achq/config.ts` | [`@achq/claude`](./claude.md) (`Agent`, `AgentConfig`) |
| `achq/registry` | Runtime & CLI | `CONTAINER_PROVIDERS`, `CHANNEL_PROVIDERS`, `POLICY_PROVIDERS`, `AGENT_PROVIDERS`, `CODE_HOST`, `VAULT_PROVIDERS` |

## Outpost primitives (`.achq/config.ts`)

### `Container` & `Policy`

Define an outpost machine alongside the credentials and startup files it receives:

```ts [.achq/config.ts]
const customPolicy = new Policy("custom", { provider: "acme-auth", scopes: ["read"] });

const dev = new Container("dev", {
  image: "./Dockerfile",
  policies: [customPolicy],
  files: {
    "~/.npmrc": "./npmrc",                  // <-- string: copied from .achq/npmrc
    "~/.config/app.json": { region: "eu" }, // <-- object: serialized as JSON
  },
});
```

Declares a scale-to-zero container image alongside its credential policies (`github.Policy` or custom `Policy`) and startup files.

### `Workspace`

Route matching channel threads into a container worktree:

```ts [.achq/config.ts]
new Workspace("issues", {
  container: dev,
  threads: channel.issues, // <-- any channel ThreadSelector
  branch: "issue-{number}",
  base: "main",
});
```

Maps threads matched by a `ThreadSelector` onto `dev` and checks out a persistent git worktree per thread from `base`.

### `Agent` & `Trigger`

Wake an agent inside that worktree when a channel event matches:

```ts [.achq/config.ts]
const coder = new claude.Agent("coder", { model: "claude-opus-5-5" });

new Trigger("mention", {
  event: channel.issueComment({ mention: "@claude" }), // <-- any channel EventSelector
  agent: coder,
});
```

Binds a channel `EventSelector` to an `Agent` subclass so matching events run the agent inside the workspace that claimed the thread.

## ACHQ primitives (`achq.infra.ts`)

Declare the central control plane graph:

```ts [achq.infra.ts]
import { achq, cloudflare, github } from "achq/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "acme-agents" });
  new cloudflare.Deployer("deployer", { router, owners: ["acme"] });
  new github.Channel("github", { name: "acme-agents", org: "acme", router });
});
```

| Export | Role |
| --- | --- |
| `achq(declare)` | Captures the resource graph for `achq infra up` and `achq infra down` |
| `Router` & `Deployer` | Base classes extended by provider plugins (`cloudflare.Router`, `railway.Router`) |

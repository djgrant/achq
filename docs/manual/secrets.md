# Secrets

Keep every secret the control plane holds in one vault that only the control plane can read:

```ts [achq.infra.ts]
import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as cloudflare from "@achq/cloudflare/infra";
import * as github from "@achq/github/infra";

export default achq(() => {
  const vault = new cloudflare.Vault("vault"); // <-- 1. where the hub's secrets live

  const router = new cloudflare.Router("router", { project: "acme-agents", vault });
  new cloudflare.Deployer("deployer", { router, owners: ["acme"] });

  new github.CodeHost("github");
  const channel = new github.Channel("github", { name: "acme-agents", org: "acme", router });

  new github.OperatorAuth("operators", { channel, logins: ["djgrant", "alice"] }); // <-- 2. who may run the CLI against the hub

  new claude.AgentRuntime("claude");
});
```

An ACHQ instance has secrets in three places: your machine, the hub (`Router` and `Deployer`), and each outpost container. This page explains what each place holds, how each secret gets there, and who can read it.

## Where secrets live

| Place | Holds | Who reads it |
| --- | --- | --- |
| **Local** | Your container provider sign-in, your `gh` login, agent runtime tokens such as `CLAUDE_CODE_OAUTH_TOKEN` | `achq` on your machine |
| **Hub vault** | `ACHQ_ROOT_KEY`, each GitHub App's private key, agent runtime tokens, the deployer's provider token | `Router` and `Deployer` only |
| **Outpost** | Its `ACHQ_CONTAINER_KEY`, agent runtime tokens, short-lived tokens the router mints | That container; agents get only the minted tokens and runtime tokens |

**The hub vault is write-only from outside the hub.** `achq infra up` writes a secret to it when a resource is created or a local value changes, and never reads one back. Holding the container provider's credentials lets you replace the hub's secrets, not read them.

## The root key

`ACHQ_ROOT_KEY` is a random key that `achq infra up` generates the first time it creates the router, writes to the vault, and then forgets. Every other secret achq makes is derived from it with HMAC, so the hub stores one key instead of many:

```text
ACHQ_ROOT_KEY
 ├─ container key   HMAC(root, repo + container)    container ⇄ router, both directions
 ├─ webhook secret  HMAC(root, App id)              GitHub ─▶ router
 ├─ admin key       HMAC(root, "admin")             router ⇄ deployer
 └─ internal key    HMAC(root, "cloudflare:…")      Cloudflare Workers' private routing (*.achq.internal)
```

Neither the router nor the deployer stores a derived key. Each derives the key when it needs it. For example, the router derives `acme-agents`' webhook secret to verify a webhook, and derives a container's key to verify that container's request for credentials.

The deployer gives each container its own `ACHQ_CONTAINER_KEY` when it deploys the container. A container can only sign as itself, so it can't impersonate another container.

## The hub vault

`Router` takes the vault, and `Deployer` uses its router's vault. Each hub provider backs its vault with its own write-only store:

| Provider | `Vault` | Backed by |
| --- | --- | --- |
| Cloudflare | `cloudflare.Vault` | Secrets Store: values can't be read back through the API; Workers read them through a binding |
| Railway | `railway.Vault` | Sealed variables: values are never shown in the dashboard or returned by the API |

**The vault and the hub are always on the same provider.** `cloudflare.Router` takes only a `cloudflare.Vault`. A vault elsewhere would need its own access credential, and that credential would have to live in the hub provider's store anyway.

The vault holds four kinds of secret:

| Secret | Written by | When |
| --- | --- | --- |
| `ACHQ_ROOT_KEY` | `achq infra up` | Once, when it creates the router |
| GitHub App private key | `achq infra up` | Once, when it creates the App; one item per App |
| Agent runtime tokens, e.g. `CLAUDE_CODE_OAUTH_TOKEN` | `achq infra up`, from your environment | When the local value changes |
| Deployer's provider token | `achq infra up` | Cloudflare: when you paste a new one (`--rotate-deployer-token`). Railway: when your `RAILWAY_API_TOKEN` changes |

`achq infra up` keeps a fingerprint of each value, never the value, so it can tell a changed local token from an unchanged one without reading the vault.

`achq infra down` leaves the vault in place, like the GitHub Apps it can't delete. A hub re-created in the same account finds its root key and App keys.

As an aside, if you lose the vault (for example, by moving to another provider), the root key is generated again and the router re-derives every webhook secret and container key. The GitHub Apps survive, but their private keys don't: generate a new private key on each App's page and `achq infra up` writes it to the new vault.

## Local credentials

`achq infra up` and `achq infra down` create, update and delete the hub, so they authenticate with your own credentials:

| Step | Credential |
| --- | --- |
| Create and deploy the hub on Cloudflare | `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` (e.g. in CI) |
| Create and deploy the hub on Railway | `RAILWAY_API_TOKEN` |
| Create a GitHub App | Your browser, through GitHub's manifest flow |
| Calls to GitHub as you, e.g. `achq repo install` | Your `gh` login |
| Copy agent runtime tokens into the vault | `CLAUDE_CODE_OAUTH_TOKEN` in your environment |

You can keep these in 1Password and load them at startup with `loadEnv` in `achq.config.ts`, beside `achq.infra.ts`:

```ts [achq.config.ts]
export default {
  loadEnv: "op run --env-file=.env --", // <-- every achq command adopts the environment this sets
};
```

`achq` runs the command once when it starts and takes on the environment it sets, so your terminal stays attached.

## Operator auth

Commands that talk to a running hub sign you in as an operator instead of using the root key: `achq infra status`, `achq infra replay`, the sync at the end of `achq infra up`, and the router calls `achq infra down` makes. The router checks who you are and returns a short-lived admin session.

**Operators are not `owners`.** `owners` on `Deployer` lists the GitHub accounts whose repos get outposts. Operators are the people allowed to run the CLI against the hub.

Each `OperatorAuth` decides who you are differently:

| `OperatorAuth` | You sign in with | Who decides access |
| --- | --- | --- |
| `github.OperatorAuth` | GitHub, through the channel's App | The router, against `logins` |
| `cloudflare.OperatorAuth` | Cloudflare Access, in your browser | Cloudflare Access, against `emails`; the router verifies Access's token |

To use Cloudflare Access instead of GitHub:

```ts [achq.infra.ts]
new cloudflare.OperatorAuth("operators", { emails: ["dj@acme.dev", "alice@acme.dev"] });
```

GitHub App operations that need an App's private key run in the router, which has the key: reading the App's settings, and reading and setting its webhook. `achq infra up` asks the router to do them.

## Short-lived tokens

The router turns App private keys into short-lived GitHub installation tokens, so nothing outside the hub holds a long-lived GitHub credential:

| Token for | Asked for by | Used to |
| --- | --- | --- |
| A container's policies | The container, signing with `ACHQ_CONTAINER_KEY` | Push branches, comment, and whatever else its `Policy` grants. The container installs them in files only its own user can read, and agents use them |
| A container's channels | The container | Read the threads its workspaces select |
| The deployer | The deployer, signing with the admin key | Read `.achq/` from a repo, and write `ACHQ_STATUS` |

A container refreshes its tokens when fewer than 30 minutes remain.

## Outposts

Outposts declare no secrets of their own. The deployer gives each container two things when it deploys it, stored as the provider's own secrets (Worker secrets on Cloudflare, sealed variables on Railway):

- its `ACHQ_CONTAINER_KEY`
- every agent runtime's tokens, read from the vault

Every container gets every runtime's tokens, whichever agents it runs.

Agents never see `ACHQ_CONTAINER_KEY` or any provider's private variables. They see the minted tokens and the runtime tokens.

## Topology

Taken together, secrets flow one way, from your machine into the vault and from the vault out to services and containers:

```text
 LOCAL                               HUB                                        OUTPOST
 ─────                               ───                                        ───────
 provider sign-in ──infra up──▶ creates and deploys Router, Deployer, Vault
 browser ───────────infra up──▶ creates GitHub App ──┐
 CLAUDE_CODE_OAUTH_TOKEN ─────────── copied ─────────┤ written, never read back
                                                     ▼
                               ┌─────────────────────────────┐
                               │ Vault                       │
                               │   ACHQ_ROOT_KEY             │
                               │   App private keys          │
                               │   runtime tokens            │
                               │   deployer token            │
                               └──────┬───────────────┬──────┘
                                bound │               │ bound
                                      ▼               ▼
 GitHub ──webhook──────────────▶ Router ◀─admin key─▶ Deployer ──deploys──▶ Container
        (signed with the          ▲   │                                       ACHQ_CONTAINER_KEY
         webhook secret)          │   │                                       runtime tokens
 operator sign-in ──session───────┘   └──minted tokens, on a request ───────▶ token files
                                         signed with the container key
```

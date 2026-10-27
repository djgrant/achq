# Plan: secrets, vaults and operator auth

Status: agreed, not started. [`docs/manual/secrets.md`](../docs/manual/secrets.md) describes the end state; this file records what changes to get there and why.

## Where we are

- The root key (`AGENT_WEBHOOK_KEY`), each GitHub App's private key (`ACHQ_GITHUB_APPS`), the agent runtimes' tokens (`ACHQ_CONTAINER_ENV`) and the deployer's provider token are stored as ordinary router and deployer variables. Core's `VariableGroup` has no notion of a secret.
- On Cloudflare those variables are kept as plaintext JSON in the project's KV namespace, so `achq infra up` can read them back to plan.
- The CLI reads the root key and the App keys back out of provider storage on every `infra up`, `infra status`, `infra replay` and `infra down`: to sign admin requests to the router, to sign App JWTs, to set webhooks, and (on Cloudflare) to derive the Workers' internal key and deploy them with their secrets. In effect, anyone with access to the provider account holds every hub secret.
- `@achq/1password` provides an optional `vault` in `achq.config.ts` that only GitHub App keys use. A `Channel` behaves differently with and without it (vault or router as the source of truth).
- `achq.config.ts`'s `env` runs a command prefix (e.g. `op run --env-file=.env --`) once at CLI startup and adopts the environment it sets.

## Principles

1. Hub secrets live in a vault on the hub's own provider, and nothing outside the hub reads them back.
2. After genesis, the CLI never reads a hub secret. It writes secrets once, when a resource is created or a local value changes.
3. The CLI has two kinds of credential, with separate jobs: local provider credentials for the hub's lifecycle, and operator auth for everything else.
4. No achq-managed store holds a secret in plaintext.

## Changes

### 1. Env names

Every achq variable gets the `ACHQ_` prefix. Names say what the value is. Vendor names (`CLAUDE_CODE_OAUTH_TOKEN`, `RAILWAY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, …) don't change.

| Today | After |
| --- | --- |
| `AGENT_WEBHOOK_KEY` | `ACHQ_ROOT_KEY` |
| `ACHQ_CONTAINER_SECRET` | `ACHQ_CONTAINER_KEY` |
| `DATA_DIR` | `ACHQ_DATA_DIR` |
| `ACHQ_1PASSWORD_OP` | removed (see 3) |

Audit the remaining names while doing this and keep the list above as the record. Deployed hubs carry the old names, so the release that renames them also migrates them on `infra up`. The CLI and services ship together, so one release is enough.

### 2. A vault per hub provider

- Each hub provider offers a `Vault` resource: `cloudflare.Vault` and `railway.Vault`. GitHub and Claude don't provide one: neither has a store the hub can read from.
  - Cloudflare: Secrets Store (account-level, write-only through the API, bound to Workers).
  - Railway: sealed variables (write-only, never returned by the API or UI).
- `Router` takes the vault. `Deployer` uses its router's vault. Both read secrets from it through the provider's binding; nothing else does.
- The vault holds the root key, each GitHub App's private key (one item per App), the agent runtimes' secrets and the deployer's provider token.
- The vault is protected, like a GitHub App: `infra down` leaves it, so a re-created hub finds its keys.
- Core distinguishes secrets from variables. Secrets are write-only and are planned by existence or by fingerprint, never by reading the value. `GENERATED` secrets (the root key) are written once and never read by the CLI again.
- A `Channel` always writes its App's key to the vault. The with/without-vault split goes away, and so do `ACHQ_GITHUB_APPS` and `router.addTo`'s read-merge-write of it.

### 3. Drop `@achq/1password`

- Delete the package, `achq.config.ts`'s `vault`, `Context.vault`, the `Vault` interface in core and the `VaultProvider` contract.
- Delete `docs/packages/1password.md` and its nav entry, and the 1Password vault text in `README.md`, `docs/packages/cli.md` and `docs/manual/credentials.md`.
- Anyone with App keys in a 1Password vault moves them into the hub vault once. Generating a new private key on the App's page also works.
- Deprecating `@achq/1password` on npm is a publish action: ask before doing it.

### 4. `env` becomes `loadEnv`

Same behaviour, clearer name: it loads environment variables for every CLI command at startup, by running a command prefix. It isn't a lifecycle hook. `loadEnv: "op run --env-file=.env --"` remains the documented way to keep local credentials in 1Password.

### 5. Operator auth

- A new contract, `OperatorAuthProvider`, and a declared resource, `OperatorAuth`, in `achq.infra.ts`. It isn't a managed resource: like `AgentRuntime`, it tells the hub something and needs no plan or apply of its own.
- Two providers ship together, so the interface isn't shaped around GitHub alone:
  - `github.OperatorAuth`: you sign in with GitHub (the channel's App, as a user-to-server token), and the router checks your login against the declared logins.
  - `cloudflare.OperatorAuth`: Cloudflare Access in front of the router's admin routes. Access decides who gets in, and the router verifies Access's token.
- The interface has to allow both: proof obtained by the CLI, verified by the router, and authorisation decided by either the provider (Access) or the router (GitHub logins).
- The router exchanges a verified operator for a short-lived admin session. Every CLI call to the router uses the session: `infra status`, `infra replay`, the sync at the end of `infra up`, and `infra down`'s admin calls.
- GitHub App operations the CLI does today with the App key move into the router, which has it: reading App settings, reading and setting the webhook. `Channel.read` and `apply` ask the router.
- Root-key derivations the CLI does today move to where the root key is bound. On Cloudflare that's the router's and deployer's internal key, so the CLI no longer reads variables to deploy them.
- The admin key (derived from the root key) stays, but only for router ↔ deployer.
- Operators and `owners` are separate: operators are people who run the CLI; `owners` are the repo owners the deployer serves.

### 6. Say what `infra up` authenticates with

Docs and `infraChecks` messages name the local credential each step uses:

- the container provider's sign-in (Wrangler login, or `CLOUDFLARE_API_TOKEN`; `RAILWAY_API_TOKEN`) for the hub's lifecycle
- the `gh` login and the browser for creating GitHub Apps
- the agent runtimes' tokens, copied into the vault

### 7. No mixing of hub and vault providers

A vault on another provider would need an access credential stored in the hub provider's native store anyway. The types enforce this: `cloudflare.Router` takes a `cloudflare.Vault`, and `railway.Router` takes a `railway.Vault`. The contract can open this up later.

### 8. No plaintext secrets on Cloudflare

This follows from 2 and 5. The KV namespace keeps only non-secret variables (URLs, plugin lists, owners, project names) and fingerprints. Secrets are only in Secrets Store or Worker secrets. Container Workers already keep only a fingerprint in KV.

### 9. Secrets topology docs

`docs/manual/secrets.md` is written for the end state. When the implementation lands:

- register it in `docs/manual/nav.ts` in place of `credentials.md`, and delete `credentials.md`
- update the credentials tables in `docs/manual/providers.md`, `docs/packages/cli.md` and `README.md` to match

## Order

1. 9 (the doc, unregistered), 6, 4, 3: docs and small changes that don't depend on the rest.
2. 1: renames, with the migration on `infra up`.
3. 5: operator auth, App operations and root-key derivations moved into the router.
4. 2 and 8: the vault resource, secrets made write-only, plaintext gone from KV.

7 is a decision, enforced by 2's types.

## Done when

- No CLI code path reads the root key or an App's private key after genesis.
- After `infra up` on Cloudflare, the KV namespace holds no secret values.
- On both providers, the root key, App keys, runtime secrets and deployer token are only in the vault.
- `infra status` and `infra replay` work with operator auth and no provider credentials.
- An existing hub upgrades with one `infra up`.

## Out of scope

- Giving each container only the runtime secrets its agents need. Today every container gets every runtime's secrets; this plan doesn't change that.
- Upgrading the router and deployer without local provider credentials.
- Operator auth for CI (e.g. GitHub Actions OIDC).

## Open questions

- Railway: can the API seal a variable, or only the dashboard? If only the dashboard, `railway.Vault` needs another backing.
- Cloudflare: Secrets Store is in beta. The fallback is per-Worker secrets, with fingerprints in KV.
- GitHub operator auth: can an App created through the manifest flow have device flow turned on, or does the CLI open its settings page? And which App signs operators in when the infra has several channels?
- Migration: on Cloudflare, existing root keys have sat in plaintext in KV. Should the upgrade rotate the root key? Rotating changes every container key and webhook secret, which the hub re-derives and re-sets.
- A lost vault (e.g. moving to another provider): the documented recovery is a new private key per App, generated on its page.

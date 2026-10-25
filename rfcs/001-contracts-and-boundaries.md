---
status: proposed
created_at: 2026-10-25
---

# Contracts and Boundaries

## Abstract

achq's services, CLI and plugins talk to each other across about a dozen boundaries: HTTP routes, the JSON store, the runner's commands over ssh, `ACHQ_STATUS` and the repo manifest. But each boundary is written down twice, once on each side, held together by matching strings and type casts, and nothing checks that the two copies agree.

We will give each boundary one definition, a schema kept next to the side that owns it, and derive both sides and their types from it. Drift between the two sides will then show up as a type error or a validation error at the boundary, instead of a stored value that a later version misreads.

## Problem

### Each contract is written twice

**Routes.** [`core/src/wire/client.ts`](../packages/core/src/wire/client.ts) writes out every router path by hand and casts each response to the type the caller asks for:

```ts
status: () => call<DeployRecord[]>("GET", "/admin/status"),
deployerVersion: () => call<DeployerVersion>("GET", "/admin/deployer"),
```

The router and deployer declare the same paths again in Hono ([`service-router/src/router.ts`](../packages/service-router/src/router.ts), [`service-deployer/src/server.ts`](../packages/service-deployer/src/server.ts)). The router renames some of them when it forwards a request to the deployer: `/admin/deployer` becomes `/version`. Nothing checks that a client's path, method or response type matches the server's.

**The store protocol.** `HttpJsonStore` in [`utils/src/http.ts`](../packages/utils/src/http.ts) is the client. `storeRequest` in [`plugin-cloudflare/worker/routes.ts`](../packages/plugin-cloudflare/worker/routes.ts) is the server. Each describes the protocol in its own comment. The two have already drifted once: the Worker still accepts the old `/<collection>/<name>` path form until deployed infras run services past cb7a2f1.

**The runner's commands.** The CLI builds the argv `["achq-agent", "sessions", thread]` and parses the JSON that comes back. The runner reads `process.argv` by hand in [`service-container/src/main.ts`](../packages/service-container/src/main.ts). The CLI's own test imports `formatSessions` from `@achq/container` to check that the two sides still agree.

**The repo manifest.** `RepoManifest` is a hand-written type in [`repo-manifest.ts`](../packages/core/src/resources/repo-manifest.ts). `manifestSchema` in [`manifest-schema.ts`](../packages/core/src/resources/manifest-schema.ts) describes the same shape again, and `validateManifest` connects the two with `parsed.data as RepoManifest`.

### Data crossing a boundary goes unchecked

In [`protocol.ts`](../packages/core/src/wire/protocol.ts), every request is a zod schema. Every response is a plain TypeScript type: `DeployRecord`, `Status`, `SyncStatus`, `FailedDelivery`, `CredentialsResponse` and the rest. The worst case is plugin-github's `JSON.parse(value) as Status`. `ACHQ_STATUS` is a repository variable that anyone who can push to the repo can edit, and the CLI trusts what it reads there.

The stores have the same gap. `Stores` is `<T>(collection: string) => JsonStore<T>`, so each caller picks `T` and nothing checks what's read. The same caller-picked casts appear in `signedClient`, `CloudflareTransport.call<T>`, `HttpJsonStore` and `disk.readJson`. Values written by an older version are read as the current type. `renameStored` and `tagStored` exist for exactly this case. The order they run in rests on comments that say "run before anything else uses the store": the router runs them at the top of `start()`, and the deployer runs them through `store.migrate()`.

### Durable work is kept in memory

The deployer keeps its sync jobs in a `Map` inside the route handler. A restart loses them, so the CLI has to notice a lost sync and start it again. The routes file is therefore also acting as a job tracker.

### Concepts without a name or a home

- **Core's contracts hold its domain model.** `channel-provider.ts` defines `ChannelEvent`, `DeployerEvent`, `Thread`, `Message`, `Credential` and `fromTrustedPerson`. `code-host-provider.ts` defines `repoName`, which about 20 files use. As a result, contracts, wire and resources all import each other.
- **The store contract lives in the wrong file.** `JsonStore` and `Stores` are declared inside `container-provider.ts`, and `renameStored` sits at core's root, outside its four parts.
- **"Agent" means three things.** The container service is called service-container, `achq-agent`, `Runner`, and `createAgent()` (which returns a `Runner`). "Agent" is also core's `Agent` resource and `AgentProvider`. Two different functions are both named `agentEnv()`.
- **The three services lay out the same parts differently.** Each builds a context, passes it to plain functions, keeps named collections and serves a signed Hono app. But the routes are in `router.ts` in one service and `server.ts` in another. The router declares its collections in `context.ts`, while the deployer wraps them in `store.ts`.
- **service-container holds two surfaces.** One is the event server. The other is the `sessions` and `resume` commands that the CLI runs over ssh. Separately, `volume.ts` mixes four things: the data layout, the thread-state store, the CLI's wire format, and delivery de-duplication.
- **The Cloudflare Worker is a separate runtime inside a plugin.** It runs on `cloudflare:workers`, not Bun, and `src/` reaches it by a relative path (`../../worker/settings.ts`).
- **The CLI.** It has a `src/` folder. `lib/` mixes per-domain flows with I/O helpers. `constants.ts` holds every domain's timeouts. Rendering is split between `format.ts` and `container.ts`.
- **Some constants sit in the wrong place.** `wire/constants.ts` holds `CONFIG_DIR` and `STATUS_VARIABLE`, which aren't part of the wire protocol. `achq/registry.ts` also holds the sandbox import map.
- **Railway builds a repo's container in `service-parts.ts`.** That file is about where achq's own services run. Cloudflare keeps the same code in `lib/container-parts.ts`.
- **test-utils is one flat folder.** Fakes are named after who uses them, for example `deployer/router.ts` and `container-router.ts`, and they sit beside vendor fakes, fixtures and helpers.

## Proposed solution

Each boundary will have one definition, owned by one side. Every concept will have one name and one home.

### 1. Core will get a model part and a store contract

Core will gain a fifth part, `core/src/model/`, holding events, threads, repos, credentials and the manifest. Contracts will then hold only interfaces, and the import cycle among contracts, wire and resources will go away. Some files will move with it:

- `resources/context.ts` will move to `engine/`.
- `manifest-schema.ts` and `repo-manifest.ts` will move to `model/`. The schema module will stay out of core's index, so the config sandbox still won't load zod.
- `ACHQ_SOURCE` and `achqStartScript` will merge into `resources/achq-source.ts`, next to Service and Placement.

A new `core/contracts/store.ts` will hold `JsonStore`, `Stores` and the collection primitive described in section 5.

### 2. Every wire type will be a schema

Every type in `protocol.ts` will become a zod schema, with its type inferred from it. That includes the responses `DeployRecord`, `Status`, `SyncStatus`, `FailedDelivery`, `CredentialsResponse`, `InstalledRepo`, `RepoInstallation`, `SourceSettings`, `ReplayResult` and `DeployerVersion`. Reading `ACHQ_STATUS` will parse against `Status` rather than cast to it.

`RepoManifest` will become `z.infer<typeof manifestSchema>`. The model will import that type with `import type`, which is erased at runtime, so the sandbox still won't load zod.

### 3. Each service will export its own client

The router and deployer will each export a typed client next to their routes, built with Hono's typed client:

```ts
// @achq/router/client
export const routerAdmin = ({ url, key }: { url: string; key: string }) =>
  hc<AdminApp>(url, { fetch: signedFetcher(adminSecret(key)) });
```

The CLI and the deployer will import `@achq/router/client`. The router will import `@achq/deployer/client` for the requests it forwards, so a renamed path becomes a type error. `core/wire/client.ts` and `signedClient` will be deleted. `hc` types responses but doesn't check them at runtime, so each client will parse responses with the schemas from section 2.

### 4. One store protocol, and the Worker as its own package

A single module, `@achq/utils/http-store`, will export both sides of the store protocol: `HttpJsonStore` and `storeHandler(memory)`. The Worker will become its own package, `@achq/cloudflare-worker`, which imports `storeHandler`. `settings.ts` will be the contract between that package and plugin-cloudflare.

### 5. Collections will be typed and will migrate themselves

A collection will be declared with its schema and its migrations:

```ts
const repos = await collection(stores, "repos", RouterRepoConfig, {
  migrate: [renamed((_name, config) => repoName.key(config.repo))],
});
```

Opening a collection will run its migrations, and every read will be checked against the schema. Nothing will be able to use a collection before it has migrated. `T` will be inferred from the schema, which removes the caller-picked casts in `Stores`, `HttpJsonStore` and `JsonDirStore`. `renameStored` and `tagStored` will become migrations of this kind, and they will still be deleted once deployed infras have run them.

### 6. Sync jobs will be durable

The deployer will keep each sync's state in a `syncs` collection. `POST /sync` will start a sync and `GET /sync/:id` will read its state. The routes will keep no state of their own. A sync that a restart cuts short will read as failed rather than not found, so the CLI will no longer need to restart lost syncs.

### 7. The router and deployer will share one file map

Both services will use this layout:

```
src/
├── main.ts       reads its environment, builds the context, serves
├── context.ts    the context, with defaults from its dependencies
├── store.ts      its collections and their migrations
├── routes.ts     its Hono apps
├── client.ts     its typed client, from section 3
└── <theme>.ts    e.g. deliveries.ts, deploy.ts
```

This is a convention, not a framework. There will be no `defineService`.

### 8. The runner

"Agent" will mean only core's `Agent`: the Claude agent a config declares. The service in the container will become the runner, the name the design doc, the README and the `Runner` class already use.

| Today | Proposed |
|---|---|
| `packages/service-container` (`@achq/container`) | `packages/service-runner` (`@achq/runner`) |
| binary `achq-agent` | `achq-runner` |
| `agent.ts`: `createAgent`, `settings`, `runLimits` | `env.ts`: `runnerFromEnv`, `settings`, `runLimits` |
| registry `agentEnv()` | `agentContainerEnv()` |
| CLI `agentEnvCheck` | `agentContainerEnvCheck` |

The runner's two surfaces will separate:

```
service-runner/src/
├── commands/          pok commands: serve.ts, sessions.ts, resume.ts
├── commands.client.ts the argv for each command and the parser for its output, plus the binary name
├── routes.ts          the event route, out of the Runner constructor
├── layout.ts          where things live on the volume
├── state.ts           thread state, and the deliveries it has handled
└── …
```

The CLI will run the runner through `@achq/runner/commands`, so a command's name, arguments and output format live in one place. The Dockerfile `CMD`, `install.sh` and the README will change by hand. This is a breaking change, and an allowed one.

### 9. Constants will live with what they describe

- `CONFIG_DIR` and `CONFIG_ENTRY` will move to `core/resources/config.ts`.
- `STATUS_VARIABLE` will move to plugin-github. The core contract only says `setStatus` and `clearStatus`. The CLI's messages that name `ACHQ_STATUS` will come from the code host, so they name wherever it keeps the status.
- `wire/constants.ts` will keep only the ports and `ENV`.
- `CONFIG_MODULES` and `INFRA_MODULES` will move from the registry to `achq/src/modules.ts`, exported as `achq/modules`.

### 10. Railway's container parts

Railway's `containerService` will move from `service-parts.ts` to `lib/container-parts.ts`, matching Cloudflare.

### 11. test-utils

```
test-utils/src/
├── fakes/vendors/   GitHub, Railway, Cloudflare
├── fakes/achq/      the router as the deployer and the runner see it
├── fixtures/
└── helpers/
```

### 12. The CLI on pok

The CLI will drop `src/`, and each folder will hold one kind of pok primitive. Tasks will be named `domain.verb` or `domain.verb-noun`, as commands are.

```
packages/cli/
├── bin/achq
├── main.ts
├── pok.config.ts
├── commands/                      unchanged
├── tasks/
│   ├── infra.load.ts              loads and checks achq.infra.ts
│   ├── infra.find-router.ts       the router's URL and key, by planning it
│   ├── infra.apply.ts             plans, reports the plan, applies
│   ├── infra.tear-down.ts         plans deletion, reports it, confirms, applies
│   ├── infra.await-deployer.ts    waits until the deployer runs a ref
│   ├── infra.sync.ts              starts a sync and polls it
│   ├── repo.evaluate-manifest.ts  evaluates .achq/ as the deployer does
│   ├── repo.ask-router.ts         asks the router ACHQ_STATUS names whether the source is installed
│   ├── repo.install.ts
│   ├── repo.uninstall.ts
│   ├── repo.read-status.ts
│   ├── container.reach.ts         picks a container and wakes it
│   └── container.list-sessions.ts
├── checks/infra.ts                the container provider's checks, the agent container variables
├── envs/config.ts                 achq.config.ts's `env` command as a resolver
└── lib/                           terminal.ts, workdir.ts, and the pure renderers and pickers
```

Tasks will be used only for steps that report, wait, prompt or are shared across commands. Pure functions will stay plain functions with direct tests: `parseSessions`, `pickSession`, `containersOf`, `pickContainer`, `sessionTable` and the renderers from `format.ts`. Each timeout will move into the task that waits on it, and `constants.ts` will be deleted. Four commands declare the same `dryRun` flag by hand; they will use pok's `dryRunContext` instead.

### 13. Types

- `CloudflareTransport` will follow Railway's typed-operation pattern, `call(operation: Operation<Vars, Result>, variables)`, so each call's type comes from its operation.
- Return types the compiler would infer will be dropped, for example `wireRecord(...): DeployRecord`. An annotation that pins an object to a contract, such as `tokenCheck(): Check`, will become `satisfies`.

## Defense

**Drift becomes an error.** After this change, each boundary from the Problem section has a single definition:

| Boundary | Defined in |
|---|---|
| Routes | the server's app type, through its client |
| The store protocol | `http-store` |
| Runner commands | `commands.client.ts` |
| The manifest | its schema |
| Responses and stored values | the schemas that parse them |

Changing one side without the other becomes either a type error or a parse error at the boundary.

**"`hc` doesn't validate responses."** Correct. Section 3 parses responses with the schemas from section 2, so the type comes from the server and the runtime check comes from the schema.

**"Validating every store read costs time."** The values are small JSON documents that services read at startup and per delivery. Parsing them costs little compared with the network round trip of `HttpJsonStore`. It also turns a misread from an older version into a clear error.

**"Migrations may still run late."** Opening a collection runs its migrations, so no code can hold a collection that hasn't migrated. Today, this ordering depends on comments.

**"Why not a `defineService` framework for the services?"** The three services need the same file map, not shared behaviour. A convention is the weaker tool, and it's enough here.

**"Why not move the vendor API clients into the plugins that use them?"** utils is where code that builds on something else lives: GitHub over Octokit, Railway and Cloudflare. Shared code moves into packages, not into its only current user.

**"Why keep two config loaders?"** The deployer evaluates configs in QuickJS because it runs untrusted code. The runner runs its own repo's config natively. The design doc makes this choice on purpose, so this RFC only names them as two strategies for one job.

**"Renaming the binary breaks users' Dockerfiles."** Breaking changes are allowed. Only `CMD`, `install.sh` and the README change.

## Related work

- Hono's typed client (`hono/client`) derives a client from a server's route types. Hono is already a dependency.
- pok's `defineTask`, `defineCheck`, `defineEnvResolver` and `dryRunContext` are the primitives the CLI currently rebuilds in `lib/`.
- Railway's transport in utils already derives each call's type from a typed operation. Section 13 applies that pattern to Cloudflare.

## Rollout

Each step will be its own commit, with `bun test` and `bun run typecheck` after each:

1. Model part, store contract and constants, the store part of typed collections, and the inferred manifest type (sections 1, 5, 9 and 2's manifest part).
2. The store protocol module and the Worker package (section 4).
3. Wire schemas and service clients (sections 2 and 3).
4. The services' file map and durable syncs (sections 6 and 7).
5. The runner (section 8).
6. Railway's container parts (section 10).
7. test-utils (section 11).
8. The CLI on pok (section 12).
9. The Cloudflare transport and return types (section 13).

Stored data keeps its format, so existing infras need no manual migration. The Worker's old path form stays until deployed infras run services past cb7a2f1.

## Open questions

- The router builds its apps inside `createRouter`. Exporting their types for `hc` across the private and public split hasn't been tried yet.
- How a pok env behaves when a required variable is missing hasn't been checked. Until it is, the agent container variables stay a check rather than a `defineEnv`.
- The exact hook through which the code host names where it keeps the status (section 9) still needs designing.
- The test rewrite: `up.test.ts` and `install.test.ts` (about 700 lines) inject `open`, `prompt`, `sleep` and `routerUrl` into plain functions. As tasks, these will be run through pok's `createRunner`, so both files will be rewritten.

## Not specified

- The vendor API clients stay in utils.
- The two config loaders stay as they are.
- The router's and deployer's behaviour, and their stored data formats, don't change.

---
status: proposed
created_at: 2026-10-25
---

# One Definition, One Home

## Abstract

achq's services, CLI and plugins meet at seven boundaries, and most are written down twice, once on each side, held together by matching strings and casts. Several concepts also have no single name or home: core's contracts hold its domain model, "agent" names three things, and three services lay out the same parts three ways.

We will give each boundary one definition, a schema declared in core's `wire/`, from which both sides and their types follow. We will give each concept one name and one home, in folders that each hold one kind of thing. Drift between two sides will then be a type error or a parse error, and a file's path will say what it holds.

## Problem

### Boundaries are written down twice

| Boundary | Side A | Side B | What's duplicated |
|---|---|---|---|
| Router and deployer routes | `core/src/wire/client.ts` | `service-router/src/router.ts`, `service-deployer/src/server.ts` | paths, methods, response types |
| Test fakes of those routes | `test-utils/src/deployer/router.ts`, `container-router.ts`, `cli/test/up.test.ts` | the real servers | paths, methods, response shapes |
| Store protocol | `HttpJsonStore` (`utils/src/http.ts`) | `storeRequest` (`plugin-cloudflare/worker/routes.ts`) | the protocol |
| Stored values | the writer, at one version | the reader, at another | the value's type |
| Runner commands | the CLI's argv | the runner's `main.ts`, and users' Dockerfiles | binary name, command names, argument order |
| `ACHQ_STATUS` | the deployer, which writes it | the CLI, which reads it | the value's type |
| Repo manifest | `RepoManifest` type | `manifestSchema` | the shape |
| Vendor APIs | each `CloudflareTransport.call<T>`, each Railway `op` | Cloudflare, Railway | the response type |

- **Routes.** `core/src/wire/client.ts` writes out every path and casts each response, e.g. `call<DeployRecord[]>("GET", "/admin/status")`. The servers declare the same paths again in Hono. The router's `/sync`, `/sync/:id`, `/status` and `/deployer` relay the deployer's raw response through `toDeployer`, renaming `/admin/deployer` to `/version` on the way, and `/sync` has no validator (`router.ts:61-64`). Responses are plain types in `protocol.ts`.
- **Store protocol.** Each side describes it in its own comment. They have drifted once: the Worker still accepts the old `/<collection>/<name>` form until deployed infras run past cb7a2f1.
- **Stored values.** `Stores` is `<T>(collection: string) => JsonStore<T>`, and both stores read with `JSON.parse(...) as T`. A value an older version wrote is read as the current type. `renameStored` and `tagStored` run first only because comments say so.
- **Sync state.** The deployer keeps the 10 newest syncs in a `Map` (`KEPT_SYNCS`). A restart empties it, so the CLI reads a 404 as "lost" and starts again (`cli/src/lib/infra.ts:164-187`). A real unknown ID looks like a restart.
- **Runner commands.** The CLI builds `["achq-agent", "sessions", thread]` by hand, and the runner reads `process.argv` by hand. `install.sh` tells users to write `CMD ["achq-agent"]` in their own `.achq/Dockerfile`, so achq can't rename its binary without breaking their repos.
- **`ACHQ_STATUS`.** Anyone who can push can edit it. plugin-github reads it with `JSON.parse(value) as Status` (`code-host/provider.ts:112`). Its name lives in core, though storing it as a variable is plugin-github's choice.
- **Manifest.** `validateManifest` joins the type and the schema with `parsed.data as RepoManifest`. The schema is strict and has limits, which is right for what a user writes, but the deployer also stores the manifest in each record (`StoredRecord.deployed.manifest`).
- **Vendor APIs.** `CloudflareTransport.call<T>` lets each caller pick its response type. Railway's `op(document, pick)` takes its types from the operation, but `pick` is still a cast.

### Concepts have no single name or home

- **Core's contracts hold its domain model.** `channel-provider.ts` defines `ChannelEvent`, `DeployerEvent`, `Thread`, `Message`, `Credential` and `fromTrustedPerson`. `code-host-provider.ts` defines `repoName`, which 21 files use. Contracts, wire and resources all import each other. `resources/` holds `context.ts`, `start-script.ts`, `manifest-schema.ts` and `repo-manifest.ts`, none of them resources.
- **"Agent" means three things.** The container service is service-container, `achq-agent`, `Runner`, and `createAgent()`, which returns a `Runner`. "Agent" is also core's `Agent` resource. And there are two `agentEnv()`s: the registry's builds the container's environment, the runner's builds the agent process's.
- **The three services lay out the same parts differently.** Routes are in `router.ts` in one and `server.ts` in another. The router declares its collections in `context.ts`, the deployer in `store.ts`. The runner's one route is inside the `Runner` constructor. service-container also holds two surfaces, the event server and the ssh commands, and `volume.ts` mixes the data layout, thread state, the CLI's wire format and delivery de-duplication.
- **The Worker is a separate runtime inside a plugin.** It runs on `cloudflare:workers`, sits outside `src/`, and 10 files reach it by `../../worker/settings.ts` or `../worker/settings.ts`.
- **Constants sit in the wrong place.** `wire/constants.ts` holds `CONFIG_DIR` and `CONFIG_ENTRY`. `ACHQ_SOURCE` and `achqStartScript` are split across two files. `achq/registry.ts` also holds the sandbox import map.
- **Railway builds a repo's container in `service-parts.ts`**, which is about achq's own services. Cloudflare keeps the same code in `lib/container-parts.ts`.
- **test-utils is one flat folder.** Fakes are named after who uses them and sit beside vendor fakes, fixtures and helpers.
- **The CLI** has a `src/`, a `lib/` that mixes per-domain flows with I/O helpers, rendering split between `format.ts` and `container.ts`, every domain's timeouts in `constants.ts`, and pok's tasks, checks, env resolvers and `dryRunContext` rebuilt by hand.
- **Compatibility shims have no shared form.** At least five wait for "deployed infras" to pass some point before they're deleted: the store's old path form, the 404 handling for `/admin/deployer`, the sync 404 restart, `renameStored` and `tagStored`. Each is described in its own words, so they're hard to find.
- **Return types are annotated where they'd be inferred,** in about 30 exported functions.

## Proposed solution

### Part 1: one definition per boundary

#### 1. Every boundary is declared in `core/src/wire/`

`wire/` will hold only what crosses a process boundary, one kind per folder:

```
core/src/wire/
├── routes/      router-admin.ts, router-public.ts, router-container.ts, deployer.ts
├── clients/     router.ts, deployer.ts
├── commands.ts  the runner's binary, each command's argv, and its output
├── protocol.ts  request, response and stored-value schemas
├── signing.ts
└── constants.ts ports and ENV
```

None of it is in core's index, so the config sandbox doesn't load zod or Hono. Core's index keeps `export type * from "./wire/protocol.ts"`.

#### 2. Routes are declared as data

Each route will be declared once with `@hono/zod-openapi`'s `createRoute`: its method, path, request schema and response schemas.

```ts
// core/src/wire/routes/deployer.ts
export const syncStatus = createRoute({
  method: "get",
  path: "/sync/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: json(SyncStatus), 404: text("no such sync") },
});
```

- **Servers** will attach handlers with `OpenAPIHono`'s `app.openapi(route, handler)`. It validates the request, and the compiler checks each `c.json(...)` against the route's response schema.
- **Clients** will be built from the same declarations by `routeClient(routes, fetch)` in `@achq/utils/http`. It fills path parameters, validates the request, and parses the response against its schema. A non-2xx answer throws `HttpError` with its status and body.
- **Fakes** in test-utils will serve the same declarations through `OpenAPIHono`, so a fake that drifts from a route is a type error.

A service package depends only on core for its peers' routes. No service imports another, and there's no dependency cycle.

**Forwarded routes are decoded and re-encoded.** The router's `/sync`, `/sync/:id`, `/status` and `/deployer` will call the deployer through `clients/deployer.ts` and answer with the value they get back. `/sync` will validate `SyncRequest`. A renamed deployer route becomes a type error in the router. The deployer client's `fetch` will go through `reach`, adapted to return a `Response`: if the deployer can't be reached it's a 504, as today. A refusal keeps its status and body.

**`signedFetcher(secret)`** will live in `wire/signing.ts`, built on `signedRequestInit`. It signs inside each attempt, as `fetchSigned` does now, because a retry can outlast the timestamp's window. The pusher client's fetcher adds the bearer token instead.

`core/src/wire/client.ts` and `signedClient` will be deleted.

#### 3. Schemas have one of two roles

Every type in `protocol.ts` will become a zod schema with its type inferred, including the responses and `Status`. Each schema has one of two roles, and its name says which:

- **An input schema** checks what a person wrote. It's strict and has limits. The manifest as the deployer evaluates it from `.achq/` is `ManifestInput`.
- **A wire or stored schema** reads what another version of achq wrote. It's a `z.looseObject`, so unknown keys pass through, and it has no limits. `RepoManifest`, as `StoredRecord.deployed` keeps it, is one.

The manifest's shape will be written once, as a function of the object constructor, so `ManifestInput` and `RepoManifest` can't drift. Its limits are added only to `ManifestInput`.

plugin-github will parse `ACHQ_STATUS` against `Status`:

```
acme/w's ACHQ_STATUS isn't a status achq can read: containers.0.location: expected object.
Deploying again rewrites it, or delete it with `gh variable delete ACHQ_STATUS -R acme/w`.
```

`STATUS_VARIABLE` will move to plugin-github. `CodeHostAsYou` will gain `statusLocation(repo)`, e.g. ``acme/w's `ACHQ_STATUS` variable``, and the CLI's three messages that name the variable will use it. The deployer and e2e tests will import it from `@achq/github`.

#### 4. The store is one utility

`@achq/utils/store` will hold every implementation of `JsonStore` and the primitives built on it. `JsonStore` and `Stores` stay in core's contracts, as part of `ContainerProvider`.

- `HttpJsonStore` and `storeHandler(memory)`, both sides of the HTTP protocol. The Worker imports `storeHandler`. The old path form moves with it.
- `JsonDirStore`.
- `collection(stores, name, schema, { migrate })`.

```ts
const repos = await collection(stores, "repos", RouterRepoConfig, {
  migrate: [renamed((_name, config) => repoName.key(config.repo))],
});
```

**What a collection guarantees:**

- `T` is inferred from the schema. The caller-picked `T` in `Stores` and the `as T` casts go away.
- Opening a collection runs its migrations before it returns. `renameStored` and `tagStored` become migrations, and core's `migrations.ts` is deleted.
- Each service's `store.ts` is the only code that receives the raw `Stores`.

**A value that fails its schema is treated as absent.** `read` returns `undefined` and `all()` skips it. Each logs the collection, the value's name and the first issue. Nothing removes the value, so a newer version can still read it, and the next write replaces it. That's the remedy: a repo whose record is unreadable deploys as if it had none, and the deploy rewrites the record. One rule, the same in every collection.

A loose schema keeps a newer version's keys only where the code writes back the value it read, as `uninstall` does with `...previous`. A write that builds a fresh value drops them. A field a newer version adds is therefore optional and must survive being dropped.

#### 5. Background work is a durable job

`@achq/utils/jobs` will build on a collection:

```ts
const syncs = jobs(await collection(stores, "syncs", Job(SyncResult)), { keep: 10, heartbeatMs: 5_000 });
const id = await syncs.start((signal) => deployer.sync(request));
const status = await syncs.status(id); // running | done | failed | interrupted
```

- Starting a job writes it as `running` with a heartbeat, removes all but the `keep` newest, and refreshes the heartbeat while it runs.
- A `running` job whose heartbeat is older than a few beats reads as `interrupted`. Nothing has to mark it at startup, so this holds while an old deployer and its replacement overlap.

The deployer's `POST /sync` and `GET /sync/:id` stay as they are. The CLI starts the sync again when it reads `interrupted`. It keeps its 404 restart for older deployers, marked as a compatibility shim (section 15).

#### 6. The runner's commands are declared in `wire/commands.ts`

`commands.ts` will hold the binary's name, the argv for `sessions(thread?)` and `resume(thread, session)`, and `parseSessions`, which moves there from the CLI. The runner's `main.ts` dispatches on the same command names, and the CLI builds every argv through it.

**Users' Dockerfiles stop naming the binary.** Each container provider will set a repo container's start command itself, as both already do for achq's own services: Railway's `startCommand` and Cloudflare's `entrypoint`. `install.sh` stops telling users to write `CMD`. Renaming the binary (section 10) is then safe now and in future.

#### 7. Vendor operations declare their results

`CloudflareTransport` will follow Railway's pattern: each endpoint is an operation declaring its method, path, parameters and result schema, and `call(operation, params)` infers its types from it. Railway's `op` will take a result schema in place of a cast. A vendor response that has changed is then a parse error naming the operation.

### Part 2: one home per concept

#### 8. Core: one kind per folder

```
core/src/
├── model/      events, threads, repos, credentials, the manifest, the config dir
├── contracts/  provider interfaces only
├── resources/  resources only
├── engine/     plan, values, context
└── wire/       section 1
```

- `ChannelEvent`, `DeployerEvent`, `Thread`, `Message`, `Credential`, `fromTrustedPerson` and `repoName` move to `model/`. The import cycle among contracts, wire and resources goes away.
- `manifest-schema.ts` and `repo-manifest.ts` merge into `model/manifest.ts`, out of core's index.
- `CONFIG_DIR` and `CONFIG_ENTRY` move to `model/config-dir.ts`.
- `ACHQ_SOURCE` and `achqStartScript` merge into `wire/achq-source.ts`: how a service fetches achq's code.
- `resources/context.ts` moves to `engine/`.
- `CONFIG_MODULES` and `INFRA_MODULES` move from the registry to `achq/src/modules.ts`, exported as `achq/modules`.

#### 9. The services share one file map and one set of signatures

```
src/
├── main.ts       reads its environment, builds the context, serves
├── context.ts    createContext(env, deps) → its context
├── store.ts      createStore(stores) → its collections, migrated
├── routes.ts     routes(ctx) → its OpenAPIHono apps, one per wire/routes declaration
└── features/     its domain logic, e.g. deliveries.ts, deploy.ts
```

The runner follows the same map. Its `store.ts` is `state.ts`, because it writes local files rather than a `JsonStore`.

#### 10. The runner

"Agent" will mean only core's `Agent`. The service in the container becomes the runner, the name the design doc, the README and the `Runner` class already use.

| Today | Proposed |
|---|---|
| `packages/service-container` (`@achq/container`) | `packages/service-runner` (`@achq/runner`) |
| binary `achq-agent` | `achq-runner` |
| `agent.ts`: `createAgent`, `settings`, `runLimits` | `from-env.ts`: `runnerFromEnv`, `settings`, `runLimits` |
| registry `agentEnv()` | `agentContainerEnv()` |
| CLI `agentEnvCheck` | `agentContainerEnvCheck` |

```
service-runner/src/
├── main.ts
├── from-env.ts   runnerFromEnv, settings, runLimits
├── routes.ts     the event route, out of the Runner constructor
├── state.ts      thread state, and the deliveries it has handled
├── commands/     serve.ts, sessions.ts, resume.ts
└── features/     runner.ts, agent-env.ts, config.ts, layout.ts
```

**Old containers and old Dockerfiles.**

- `install.sh` links both `achq-runner` and `achq-agent`.
- The deployer adds a warning to a repo's deploy when its `.achq/Dockerfile` still names `achq-agent`.
- The CLI finds the binary's name once, from its non-interactive `sessions` call: if `achq-runner` isn't found, it runs `achq-agent`. `resume` uses whichever name answered.
- The `achq-agent` link and the fallback are compatibility shims, deleted once deployed repos' Dockerfiles no longer name it.

#### 11. The Worker is its own package

`plugin-cloudflare/worker/` becomes `packages/cloudflare-worker` (`@achq/cloudflare-worker`). `settings.ts` is its exported contract with plugin-cloudflare, replacing the 10 relative imports.

#### 12. Railway's container parts

`containerService` moves from `service-parts.ts` to `plugin-railway/src/lib/container-parts.ts`, matching Cloudflare.

#### 13. test-utils

```
test-utils/src/
├── fakes/vendors/   GitHub, Railway, Cloudflare
├── fakes/achq/      the router and deployer, served from wire/routes
├── fixtures/
└── helpers/
```

#### 14. The CLI on pok

The CLI drops `src/`, and each folder holds one kind of thing. Tasks are named `domain.verb` or `domain.verb-noun`, as commands are.

```
packages/cli/
├── bin/achq
├── main.ts
├── pok.config.ts
├── commands/     unchanged
├── tasks/        infra.load, infra.find-router, infra.apply, infra.tear-down, infra.await-deployer,
│                 infra.sync, repo.evaluate-manifest, repo.ask-router, repo.install, repo.uninstall,
│                 repo.read-status, container.reach, container.list-sessions
├── checks/       infra.ts: the container provider's checks and the agent container variables
├── envs/         config.ts: achq.config.ts's `env` command as a resolver
├── renderers/    plan.ts, sync.ts, sessions.ts: what format.ts and container.ts render
├── pickers/      container.ts, session.ts
└── io/           terminal.ts, workdir.ts
```

- Tasks are only for steps that report, wait, prompt or are shared across commands. Renderers and pickers stay pure functions with direct tests.
- Each timeout moves into the task that waits on it, and `constants.ts` is deleted.
- The four commands that declare `dryRun` by hand use pok's `dryRunContext`.
- `up.test.ts` and `install.test.ts` pass `open`, `prompt`, `sleep` and `routerUrl` as task params through pok's `createRunner`.
- The agent container variables stay a check, not a `defineEnv`, until we've checked how a pok env behaves when a required variable is missing.

#### 15. Compatibility shims have one form

Every shim will carry one comment, in one form, so `rg "compat:"` lists them all:

```ts
// compat: delete once deployed infras run past <commit or change>. <what it keeps working>
```

The five existing shims get it in the first step. Every shim this RFC adds uses it.

#### 16. Return types

Return types the compiler would infer are dropped. An annotation that pins a value to a contract becomes `satisfies`, e.g. `tokenCheck() satisfies Check`. One that deliberately narrows a value, as `wireRecord` strips `deployed`, stays.

## Version skew

The CLI talks to services at their deployed `ACHQ_REF`, and the router, deployer and runner restart onto a new ref at different times. These rules are expand/contract: add, wait until deployed infras run the addition, then remove.

- Every wire and stored schema is a `z.looseObject`. Input schemas are strict, because only a person writes them.
- A field added to a wire or stored schema is optional or has a default.
- A field is removed only after a version that deployed infras have run has made it optional.
- A new route keeps the existing handling of an older server's 404.
- Requests strip unknown keys, so a newer CLI's extra field is ignored by an older server.
- A newer enum value can reach an older client. An older CLI that reads `interrupted` treats it as not running and reports the sync failed. Running the command again works. I accept that.
- Every step that relies on this is a shim in section 15's form.

## Behaviour changes

- A response that fails its schema is an error. A stored value that fails is treated as absent and logged.
- The deployer gains a `syncs` collection and the `interrupted` state. Existing collections keep their stored format.
- The router's forwarded routes answer with re-encoded JSON. A deployer refusal keeps its status and body.
- An unreadable `ACHQ_STATUS` gets the message in section 3.
- Repo containers' start command is set by their container provider. A Dockerfile's `CMD` is ignored, and one naming `achq-agent` gets a deploy warning.
- The binary is `achq-runner`, and `achq-agent` keeps working.

## Defense

**Drift becomes an error.**

| Boundary | Defined in | Drift shows up as |
|---|---|---|
| Routes and their fakes | `wire/routes/` | a type error |
| Store protocol | `@achq/utils/store` | nothing to drift: one module |
| Stored values | the collection's schema | a logged, absent value |
| Runner commands | `wire/commands.ts` | a type error |
| `ACHQ_STATUS` | `Status` | a parse error with a remedy |
| Manifest | one shape, two roles | a type error |
| Vendor APIs | each operation's result schema | a parse error naming the operation |

**"Why declare routes as data rather than infer clients from Hono's app types?"** Data is the less powerful form. It needs no server builder pulled out of a closure, no type-only dependency between services, and no inference across the signing middleware. Fakes and clients read the same declarations. `@hono/zod-openapi` is built for this and sits on the Hono and zod achq already uses.

**"Treating a bad value as absent hides it."** It's logged with what failed. The alternative, throwing, leaves a repo that can never deploy, because a deploy is what rewrites its record.

**"Validating every store read costs time."** The values are small JSON documents. Parsing one costs little next to `HttpJsonStore`'s round trip.

**"Why a job primitive for one use?"** Sync is the first background job, not the last. A heartbeat is also what makes `interrupted` correct while two deployers overlap, which marking at startup can't be.

**"Why not a `defineService` framework instead of a file map?"** The services need the same layout and signatures, not shared behaviour. A convention is the weaker tool, and it's enough.

**"Renaming the binary breaks users' repos."** Providers set the start command, `install.sh` links both names, and the CLI falls back until the shim is deleted.

## Prerequisites

These must be tried before this RFC is accepted:

1. **Routes as data.** Serve the router's admin app through `OpenAPIHono` behind `signedBy`, and show that `app.openapi` checks the handler's `c.json` against the route's responses under bun's typecheck.
2. **`routeClient`.** Build it for the same routes and show that its parameter and result types come from the declarations.
3. **Start commands.** Show that each provider can set a repo container's start command over the image's `CMD`.

## Rollout

1. The prerequisites.
2. The `compat:` comment on the existing shims (section 15).
3. Core's folders (section 8), so later steps add files in their final homes.
4. Wire schemas, the manifest's two roles, `ACHQ_STATUS` parsing, `STATUS_VARIABLE` and `statusLocation` (section 3).
5. `@achq/utils/store`, with the router's and deployer's collections (section 4).
6. `@achq/utils/jobs` and the deployer's syncs (section 5).
7. Route declarations, `routeClient`, `signedFetcher`, the servers, the forwarded routes and the fakes (section 2).
8. `wire/commands.ts` and provider-set start commands (section 6).
9. The services' file map (section 9).
10. The runner's rename and split (section 10).
11. The Worker package (section 11).
12. Railway's container parts (section 12).
13. test-utils (section 13).
14. The CLI on pok (section 14).
15. Vendor operations (section 7).
16. Return types (section 16).

## Not specified

- The request schemas' contents, which are already schemas.
- The vendor API clients stay in utils, where code that builds on something else lives.
- The two config loaders stay as they are. The design doc makes them deliberate.

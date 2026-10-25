---
status: proposed
created_at: 2026-10-25
---

# Contracts

## Abstract

achq's services, CLI and plugins depend on each other across seven boundaries: the router's and deployer's routes, the JSON store protocol, the stored values themselves, the runner's commands over ssh, `ACHQ_STATUS`, the repo manifest and the Cloudflare API. But most of these are written down twice, once on each side, held together by matching strings and casts, and nothing checks that the two sides agree.

We will give each boundary one definition, a schema owned by one side, from which both sides and their types follow. Drift between the two sides will then show up as a type error or a validation error at the boundary, rather than as a stored value that a later version misreads. Rules for version skew will keep services and CLIs at different versions working with each other.

## Problem

| Boundary | Side A | Side B | What's duplicated |
|---|---|---|---|
| Router and deployer routes | `core/src/wire/client.ts` | `service-router/src/router.ts`, `service-deployer/src/server.ts` | paths, methods, response types |
| Store protocol | `HttpJsonStore` (`utils/src/http.ts`) | `storeRequest` (`plugin-cloudflare/worker/routes.ts`) | the protocol |
| Stored values | the writer, at one version | the reader, at another | the value's type |
| Runner commands | the CLI's argv | the runner's `main.ts` | binary name, command names, argument order |
| `ACHQ_STATUS` | the deployer, which writes it | the CLI, which reads it | the value's type |
| Repo manifest | `RepoManifest` type | `manifestSchema` | the shape |
| Cloudflare API | each `CloudflareTransport.call<T>` | Cloudflare | the response type |

### Routes

[`core/src/wire/client.ts`](../packages/core/src/wire/client.ts) writes out every path by hand and casts each response to a type the caller chooses:

```ts
status: () => call<DeployRecord[]>("GET", "/admin/status"),
deployerVersion: () => call<DeployerVersion>("GET", "/admin/deployer"),
```

The servers declare the same paths again in Hono. Four of the router's admin routes, `/sync`, `/sync/:id`, `/status` and `/deployer`, go through `toDeployer`. It relays the deployer's raw response and renames one path on the way: `/admin/deployer` becomes `/version`. `/sync` also has no validator ([`router.ts:61-64`](../packages/service-router/src/router.ts)). Nothing checks that a client's path, method or response type matches the server's.

Requests are already zod schemas, but responses are plain TypeScript types in [`protocol.ts`](../packages/core/src/wire/protocol.ts): `DeployRecord`, `SyncStatus`, `FailedDelivery`, `CredentialsResponse` and the rest.

### The store protocol and stored values

`HttpJsonStore` is the client side and `storeRequest` the server side. Each describes the protocol in its own comment. They have already drifted once: the Worker still accepts the old `/<collection>/<name>` path form until deployed infras run services past cb7a2f1.

`Stores` is `<T>(collection: string) => JsonStore<T>`. Each caller picks `T`, and both store classes read with `JSON.parse(...) as T`. A value written by an older version is read as the current type. `renameStored` and `tagStored` exist for exactly this case. The order they run in rests on comments that say "run before anything else uses the store": the router runs them at the top of `start()`, and the deployer runs them through `store.migrate()`.

The deployer keeps sync jobs in a `Map` of the 10 newest (`KEPT_SYNCS`), inside the route handler. `POST /sync` starts a sync and `GET /sync/:id` reports on it. A restart empties the map, so the CLI reads a 404 as "lost" and starts the sync again ([`cli/src/lib/infra.ts:164-187`](../packages/cli/src/lib/infra.ts)). A real unknown ID looks exactly like a restart.

### Runner commands

The output format is already a single schema: the runner's `formatSessions` and the CLI's `parseSessions` both use `SessionSummary` from `protocol.ts`. What's duplicated is everything else. The CLI builds `["achq-agent", "sessions", thread]` and `["achq-agent", "resume", thread, session]`. The runner reads `process.argv` by hand in [`service-container/src/main.ts`](../packages/service-container/src/main.ts).

### `ACHQ_STATUS`

`ACHQ_STATUS` is a repository variable that anyone who can push to the repo can edit. plugin-github reads it with `JSON.parse(value) as Status` ([`code-host/provider.ts:112`](../packages/plugin-github/src/code-host/provider.ts)), and the CLI trusts the result. The variable's name, `STATUS_VARIABLE`, lives in core's `wire/constants.ts`. Core's contract, however, only says `setStatus` and `clearStatus`. Storing the status as a GitHub variable is plugin-github's choice.

### The manifest and the Cloudflare API

`RepoManifest` is a hand-written type in [`repo-manifest.ts`](../packages/core/src/resources/repo-manifest.ts), and [`manifest-schema.ts`](../packages/core/src/resources/manifest-schema.ts) describes the same shape. `validateManifest` connects the two with `parsed.data as RepoManifest`.

`CloudflareTransport.call<T>` lets each caller choose its response type. Railway's transport in the same package already avoids this: `call(operation: Operation<Vars, Result>, variables)` takes its types from the operation.

## Proposed solution

### 1. Every wire type will be a schema

Every type in `protocol.ts` will become a zod schema, with its type inferred, including the responses and `Status`. Core's index already uses `export type * from "./wire/protocol.ts"`, so the inferred types won't load zod in the config sandbox.

`RepoManifest` will become `z.infer<typeof manifestSchema>`. `repo-manifest.ts` will import it with `import type`. The schema module will stay out of core's index.

plugin-github will parse `ACHQ_STATUS` against `Status`. When the value fails, the message will say what's wrong and keep today's remedy:

```
acme/w's ACHQ_STATUS isn't a status achq can read: containers.0.location: expected object.
Deploying again rewrites it, or delete it with `gh variable delete ACHQ_STATUS -R acme/w`.
```

`STATUS_VARIABLE` will move to plugin-github. `CodeHostAsYou` will gain `statusLocation(repo)`, a short description such as ``acme/w's `ACHQ_STATUS` variable``. The CLI's three messages that name the variable will use it.

### 2. Each service will export its own client

The router and deployer will each export a typed client from `src/client.ts`, as `@achq/router/client` and `@achq/deployer/client`. Each client will be built with Hono's typed client (`hono/client`) from the server's app type:

```ts
// service-router/src/client.ts
import type { AdminApp, PublicApp, ContainerApp } from "./routes.ts";

export const routerAdmin = ({ url, key }: { url: string; key: string }) =>
  parsed(hc<AdminApp>(url, { fetch: signedFetcher(adminSecret(key)) }), {
    status: DeployRecord.array(),
    syncStatus: SyncStatus,
    // …
  });
```

**A response has one definition: its schema.** A server will answer with `c.json(value satisfies DeployRecord[])`, using the type inferred from the schema, as the deployer already does for `/version`. Its client will parse the response against the same schema at runtime. The compiler then checks the server against the schema, and the parse checks what actually arrives.

**Forwarded routes will be decoded and re-encoded.** The router's `/sync`, `/sync/:id`, `/status` and `/deployer` will call the deployer through `@achq/deployer/client` and answer with the value they get back. They will no longer relay a raw `Response`. `/sync` will validate `SyncRequest`. The CLI then gets request and response types for these routes, and a renamed deployer path becomes a type error in the router. The deployer client's `fetch` will go through `reach`, so a forwarded request still wakes the deployer. If the deployer can't be reached, the router answers 504 as it does today. If the deployer refuses a request, the router answers with the same status and body.

**`signedFetcher(secret)` is new.** It will live in `core/src/wire/signing.ts` and be built on `signedRequestInit`. It must sign the method, the pathname and the body exactly as `verifySigned` checks them. `routerForPusher`'s fetcher will add the bearer token instead.

**Packages will depend on each other's types only.** The deployer and the CLI will import `@achq/router/client`, and so will the runner, for `/credentials`. The router will import `@achq/deployer/client`. Today neither service package depends on the other. Each `client.ts` will import its server's app type with `import type` and nothing else from the server. Each consumer will list the other package as a devDependency used only for types. The repo has one tsconfig and no project references, so the types resolve. Nothing from a server is loaded at runtime.

`core/src/wire/client.ts` and `signedClient` will be deleted.

### 3. One store protocol module

`@achq/utils/http-store` will export both sides of the store protocol: `HttpJsonStore` and `storeHandler(memory)`. The Worker will import `storeHandler` instead of defining `storeRequest`. The compatibility path for the old path form will move with it, still deleted once deployed infras run past cb7a2f1.

### 4. Collections will be typed and will migrate themselves

`JsonStore`, `Stores` and a new `collection` primitive will move to `core/src/contracts/store.ts`:

```ts
const repos = await collection(stores, "repos", RouterRepoConfig, {
  migrate: [renamed((_name, config) => repoName.key(config.repo))],
});
```

**What a collection guarantees:**

- `T` is inferred from the schema. The caller-picked type in `Stores`, and the `as T` casts in `HttpJsonStore` and `JsonDirStore`, go away.
- Opening a collection runs its migrations before it returns. `renameStored` and `tagStored` become migrations of this kind, deleted as today once deployed infras have run them.
- Each service's `store.ts` is the only code that receives the raw `Stores`. Contexts and handlers get collections. That is what makes "nothing uses a collection before it's migrated" true.

**When a read fails its schema:**

- `read(name)` throws an error naming the collection, the value's name and the first issue.
- `all()` logs each value that fails and skips it. It doesn't remove or rewrite the value, so a router's startup and its other deliveries continue, and a newer version can still read what this one couldn't.
- Stored schemas will be `z.looseObject`. A value keeps keys its reader doesn't know when it's written back, so an older service doesn't drop a newer service's fields.

### 5. Sync state will be kept in a collection

The routes stay as they are. Only the `Map` will be replaced:

- Each sync will be kept in a `syncs` collection by ID, with its start time and its `SyncStatus`, including the full `SyncResult`. A result is lists of repo names, so it's small.
- Starting a sync will remove all but the 10 newest by start time, as `KEPT_SYNCS` does now.
- At startup, the deployer will mark each sync still `running` as `interrupted`, a new `SyncStatus` state. This relies on there being one deployer instance, which the design has today.
- The CLI will start the sync again when it reads `interrupted`. It will also keep its 404 restart for deployers older than this change, and delete it once deployed infras run past it. After that, a 404 means an unknown ID and is an error.

### 6. The runner's commands will have a client

The runner will export `@achq/container/client` from `src/client.ts`. It will hold the binary's name, the argv for each command (`sessions(thread?)` and `resume(thread, session)`), and `parseSessions`, which moves there from the CLI. The runner's `main.ts` will dispatch on the same command names. The CLI will build every argv through the client. The client won't import the event server, so the CLI won't load it. (RFC 002 renames the package to `@achq/runner`.)

### 7. Cloudflare calls will be typed operations

`CloudflareTransport` will follow Railway's pattern. Each endpoint will be an operation declaring its method, path, parameters and result, and `call(operation, params)` will infer its types from it.

## Version skew

The CLI talks to services running at their deployed `ACHQ_REF`. The router, the deployer and the runner each restart onto a new ref at different times. And `ACHQ_STATUS` may have been written by an older deployer. Once responses and stored values are parsed, these rules keep mixed versions working:

- Every response, stored value and `Status` schema is a `z.looseObject`, so unknown keys pass through.
- A field added to any of them is optional or has a default.
- A field is removed only after it has been optional in a version that deployed infras have run. This is the same rule as "delete once deployed infras have run it".
- A new route keeps the existing handling of an older server's 404, as `up.test.ts:96` does for `/admin/deployer`.
- Requests already strip unknown keys, so a newer CLI's extra field is ignored by an older server.
- A newer enum value can still reach an older client. An older CLI that reads `interrupted` treats it as "not running" and reports the sync failed. Running the command again works. I accept that.

## Behaviour changes

- A response or stored value that fails its schema is now an error, or a skipped value in `all()`, where it used to be a value of the wrong type.
- The deployer gains a `syncs` collection and the `interrupted` state. The existing collections keep their stored format.
- The router's forwarded routes answer with re-encoded JSON. A deployer refusal keeps its status and body.
- An `ACHQ_STATUS` that fails its schema gets the message in section 1. The CLI's messages describe the status by where the code host keeps it.

## Defense

**Drift becomes an error.** Each boundary in the Problem section ends up with one definition:

| Boundary | Defined in |
|---|---|
| Routes | the server's app type, plus the response schemas |
| The store protocol | `http-store` |
| Stored values | the collection's schema |
| Runner commands | `client.ts` |
| `ACHQ_STATUS` | `Status` |
| The manifest | `manifestSchema` |
| Cloudflare API | its operations |

Changing one side without the other becomes either a type error or a parse error at the boundary.

**"`hc` doesn't validate responses."** Correct. The client parses each response with its schema, and the server is checked against the same schema with `satisfies`.

**"Validating every store read costs time."** The values are small JSON documents. Parsing one costs little next to `HttpJsonStore`'s network round trip.

**"A bad record will stop the router."** `all()` skips it and logs it, so startup and other deliveries continue.

**"An older service will drop a newer service's fields."** Loose schemas keep keys a reader doesn't know.

**"Migrations may still run late."** Opening a collection runs its migrations, and only `store.ts` sees the raw stores.

## Prerequisites

These must be tried before this RFC is accepted:

1. **App types.** `createRouter` builds its admin and public apps in a closure and returns only `.fetch`. `deployerHandler` also returns only `.fetch`. Section 2 needs those builders pulled out, for example `type AdminApp = ReturnType<typeof adminApp>`, and needs `hc<AdminApp>` to infer request and response types across the signing middleware. This must be shown on the router's admin app.
2. **The type-only devDependency cycle** (router and deployer) must install and typecheck under bun.

## Relationship to RFC 002

RFC 002 moves files and renames concepts, but changes no contract. It renames `@achq/container/client` to `@achq/runner/client` and moves `core/src/contracts/store.ts`'s neighbours into `core/src/model/`. Either RFC can land first.

## Rollout

Each step will be its own commit, with `bun test` and `bun run typecheck` after each.

1. The prerequisites.
2. `contracts/store.ts` and `collection`, with the router's and deployer's collections typed (section 4).
3. `@achq/utils/http-store` (section 3).
4. Response, `Status` and manifest schemas, and plugin-github's `ACHQ_STATUS` parsing (section 1).
5. `signedFetcher`, the service clients and the forwarded routes (section 2).
6. The `syncs` collection and `interrupted` (section 5).
7. The runner's client (section 6).
8. `STATUS_VARIABLE` to plugin-github, and `statusLocation` (section 1).
9. Cloudflare operations (section 7).

## Not specified

- Where files live and what concepts are named. That's RFC 002.
- The request schemas, which are already schemas.

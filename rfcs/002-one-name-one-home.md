---
status: proposed
created_at: 2026-10-25
---

# One Name, One Home

## Abstract

achq's README prescribes where each kind of code lives, but several concepts have no single name or home. Core's contracts hold its domain model, "agent" names three different things, three services lay out the same parts three different ways, and the CLI keeps its flows, renderers and every domain's timeouts in one `lib/`. As a result, a file's path doesn't say what it holds, and a name doesn't say which thing it means.

We will give each concept one name and one home. Files will move and concepts will be renamed, but no contract will change. A reader will then be able to find code by its name, and code that does the same job in two places will be laid out the same way.

## Problem

- **Core's contracts hold its domain model.** `channel-provider.ts` defines `ChannelEvent`, `DeployerEvent`, `Thread`, `Message`, `Credential` and `fromTrustedPerson`. `code-host-provider.ts` defines `repoName`, which 21 files use. As a result, contracts, wire and resources all import each other. `resources/` also holds files that aren't resources: `context.ts`, `start-script.ts`, `manifest-schema.ts` and `repo-manifest.ts`.
- **"Agent" means three things.**
  - The container service is called service-container, `achq-agent`, `Runner`, and `createAgent()`, which returns a `Runner`.
  - "Agent" is also core's `Agent` resource and `AgentProvider`.
  - Two different functions are named `agentEnv()`: the registry's, which builds the container's environment, and the runner's, which builds the agent process's environment.
- **The three services lay out the same parts differently.** Each builds a context, passes it to plain functions, keeps named collections and serves a signed Hono app. But:
  - the routes are in `router.ts` in one and `server.ts` in another;
  - the router declares its collections in `context.ts`, while the deployer wraps them in `store.ts`;
  - the runner's one route is defined inside the `Runner` constructor.
- **service-container holds two surfaces.** One is the event server. The other is the `sessions` and `resume` commands that the CLI runs over ssh. `volume.ts` mixes four things: the data layout, the thread-state store, the CLI's wire format, and delivery de-duplication.
- **The Cloudflare Worker is a separate runtime inside a plugin.** It runs on `cloudflare:workers`, not Bun. It sits outside `src/`, and 8 files reach it by the relative path `../../worker/settings.ts`.
- **Some constants sit in the wrong place.**
  - `wire/constants.ts` holds `CONFIG_DIR` and `CONFIG_ENTRY`, which aren't part of the wire protocol.
  - `ACHQ_SOURCE` and `achqStartScript` are split across two files, though both describe where achq's code lives and how a service fetches it.
  - `achq/registry.ts` also holds the sandbox import map.
- **Railway builds a repo's container in `service-parts.ts`.** That file is about where achq's own services run. Cloudflare keeps the equivalent code in `lib/container-parts.ts`.
- **test-utils is one flat folder.** Fakes are named after who uses them, for example `deployer/router.ts` and `container-router.ts`, and they sit beside vendor fakes, fixtures and helpers.
- **The CLI.**
  - It has a `src/` folder.
  - `lib/` mixes per-domain flows with I/O helpers.
  - Rendering is split between `format.ts` and `container.ts`.
  - `constants.ts` holds every domain's timeouts.
  - pok's tasks, checks, env resolvers and `dryRunContext` are rebuilt by hand.
- **Return types are annotated where they'd be inferred,** in about 29 exported functions, for example `wireRecord(...): DeployRecord`.

## Proposed solution

### 1. Core will get a model part

`core/src/model/` will hold events, threads, repos, credentials and the manifest. Contracts will hold only interfaces, and the import cycle among contracts, wire and resources will go away.

- `resources/context.ts` will move to `core/src/engine/`.
- `manifest-schema.ts` and `repo-manifest.ts` will move to `core/src/model/`. The schema module will stay out of core's index.
- `ACHQ_SOURCE` and `achqStartScript` will merge into `core/src/resources/achq-source.ts`.
- `CONFIG_DIR` and `CONFIG_ENTRY` will move to `core/src/resources/config.ts`.
- `wire/constants.ts` will keep only the ports and `ENV`.
- `CONFIG_MODULES` and `INFRA_MODULES` will move from the registry to `achq/src/modules.ts`, exported as `achq/modules`.

### 2. The services will share one file map

```
src/
├── main.ts       reads its environment, builds the context, serves
├── context.ts    the context, with defaults from its dependencies
├── store.ts      its collections and their migrations
├── routes.ts     its Hono apps
├── client.ts     its typed client (RFC 001)
└── <theme>.ts    e.g. deliveries.ts, deploy.ts
```

The runner will follow the same map. Its `store.ts` will be `state.ts`, because it keeps local files rather than a `JsonStore`.

### 3. The runner

"Agent" will mean only core's `Agent`: the Claude agent a config declares. The service in the container will become the runner, the name the design doc, the README and the `Runner` class already use.

| Today | Proposed |
|---|---|
| `packages/service-container` (`@achq/container`) | `packages/service-runner` (`@achq/runner`) |
| `@achq/container/client` (RFC 001) | `@achq/runner/client`, mapped to `src/client.ts` |
| binary `achq-agent` | `achq-runner` |
| `agent.ts`: `createAgent`, `settings`, `runLimits` | `env.ts`: `runnerFromEnv`, `settings`, `runLimits` |
| registry `agentEnv()` | `agentContainerEnv()` |
| CLI `agentEnvCheck` | `agentContainerEnvCheck` |

Its surfaces will separate:

```
service-runner/src/
├── commands/   pok commands: serve.ts, sessions.ts, resume.ts
├── client.ts   the binary's name, each command's argv, parseSessions
├── routes.ts   the event route, out of the Runner constructor
├── layout.ts   where things live on the volume
├── state.ts    thread state, and the deliveries it has handled
└── …
```

**Old containers.** Running containers keep their old image until it's rebuilt. During the transition:

- `install.sh` will link both `achq-runner` and `achq-agent`.
- The CLI will run `achq-runner`. When the container's shell answers "not found" (exit 127), the CLI will run `achq-agent` instead.
- The fallback will be deleted once deployed containers have been rebuilt.

The Dockerfile `CMD` and the README will change.

### 4. The Worker will be its own package

`plugin-cloudflare/worker/` will become `packages/cloudflare-worker` (`@achq/cloudflare-worker`). `settings.ts` will be its exported contract with plugin-cloudflare, replacing the 8 relative imports.

### 5. Railway's container parts

`containerService` will move from `service-parts.ts` to `plugin-railway/src/lib/container-parts.ts`, matching Cloudflare.

### 6. test-utils

```
test-utils/src/
├── fakes/vendors/   GitHub, Railway, Cloudflare
├── fakes/achq/      the router as the deployer and the runner see it
├── fixtures/
└── helpers/
```

### 7. The CLI on pok

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

**What stays a plain function.** Tasks are only for steps that report, wait, prompt or are shared across commands. Pure functions stay plain functions with direct tests: `pickSession`, `containersOf`, `pickContainer`, `sessionTable` and the renderers from `format.ts`.

**Constants and flags.** Each timeout will move into the task that waits on it, and `constants.ts` will be deleted. Four commands declare the same `dryRun` flag by hand; they will use pok's `dryRunContext`.

**Tests.** `up.test.ts` and `install.test.ts` (about 700 lines) inject `open`, `prompt`, `sleep` and `routerUrl` into plain functions. They will be rewritten to pass these as task params through pok's `createRunner`.

### 8. Return types

Return types the compiler would infer will be dropped. An annotation that pins an object to a contract, such as `tokenCheck(): Check`, will become `satisfies`.

## Defense

**"Why not a `defineService` framework instead of a file map?"** The three services need the same layout, not shared behaviour. A convention is the weaker tool, and it's enough here.

**"Renaming the binary breaks running containers."** `install.sh` links both names, and the CLI falls back to `achq-agent` until containers have been rebuilt.

**"Why is the runner's store called `state.ts`?"** It isn't a `JsonStore`. It writes local files on its own volume with synchronous disk calls. Giving it a different name keeps "store" meaning one thing.

## Open questions

- How a pok env behaves when a required variable is missing hasn't been checked. Until it is, the agent container variables stay a check rather than a `defineEnv`.

## Relationship to RFC 001

This RFC changes no contract. It renames RFC 001's `@achq/container/client` to `@achq/runner/client`. It also places the model next to RFC 001's `core/src/contracts/store.ts`. Either RFC can land first.

## Rollout

Each step will be its own commit, with `bun test` and `bun run typecheck` after each.

1. Core's model part.
2. Constants and modules.
3. The services' file map.
4. The runner's rename and split.
5. The Worker package.
6. Railway's container parts.
7. test-utils.
8. The CLI on pok.
9. Return types.

## Not specified

- The vendor API clients stay in utils. utils is where code that builds on something else lives.
- The two config loaders stay as they are. The design doc makes them deliberate.

# achq

Agent Communications Headquarters.

Mention `@claude` on a GitHub issue and Claude Code works on it in a container on Railway or Cloudflare: it answers questions, edits the issue, and pushes branches and PRs. Each repo declares its own containers, agents and triggers in `.achq/`, and gets them by installing a GitHub App.

The design and the reasons behind it are in [docs/achq-design.md](docs/achq-design.md).

## Layers

- **achq** (this repo): the CLI, the router, the deployer, the container runtime, and the packages repos and the infra import: `@achq/core` and a plugin per vendor.
- **ACHQ infra**: a repo with `achq.infra.ts`, declaring the router, the deployer and the GitHub Apps. `achq infra up` runs it.
- **ACHQ repos**: any repo with `.achq/config.ts` and a Dockerfile. Installing one of the infra's Apps on it deploys it.

## The infra

```ts
// achq.infra.ts
import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";

export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  // Runs in its router's Railway project, and puts containers there.
  new railway.Deployer("deployer", { router, owners: ["djgrant", "notationlabs"] });
  new github.CodeHost("github");
  new github.Channel("personal", { name: "djgrant-claude", router });
  new github.Channel("notation", { name: "notation-achq", org: "notationlabs", router });
  // What the containers' agents run on.
  new claude.AgentRuntime("claude");
});
```

On Cloudflare, the router and deployer are Workers, each running its service in a container:

```ts
// achq.infra.ts
import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as cloudflare from "@achq/cloudflare/infra";
import * as github from "@achq/github/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "achq" });
  // Builds containers with Workers Builds, with a token of its own.
  new cloudflare.Deployer("deployer", { router, owners: ["djgrant", "notationlabs"], sshKeys: ["ssh-ed25519 AAAA… me@laptop"] });
  new github.CodeHost("github");
  new github.Channel("personal", { name: "djgrant-claude", router });
  new claude.AgentRuntime("claude");
});
```

`sshKeys` are public key lines, as in `~/.ssh/id_ed25519.pub`, that the deployer writes into each container Worker's `authorized_keys`. `achq container ssh` and `resume` open a shell with `wrangler containers ssh`, which connects as one of them, with its private key on your machine; a container Worker without any can't be reached that way. Railway doesn't need them: `railway ssh` connects as you're signed in to Railway.

Add `@achq/core` and the plugins the infra imports to the infra repo: `pnpm add -D @achq/core @achq/railway @achq/github @achq/claude`. `achq infra up` imports `achq.infra.ts` as any module, so its imports are the versions installed there, and the versions the router, deployer and containers install: each resource carries its plugin's package and version, and `achq infra up` collects them, per process, and gives each process its list, after checking every one is on npm and takes the services' version of core. The router and deployer run `@achq/router` and `@achq/deployer` at that version of core. A plugin of your own is installed the same way. A repo's `.achq/config.ts` takes `pnpm add -D @achq/core @achq/github @achq/claude` for types, and can import core and the plugins the infra installs in containers: channels', policies' and runtimes'.

`achq infra up` needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in its environment, and its container provider's credentials: `RAILWAY_API_TOKEN` on Railway. On Cloudflare, it needs no API token: sign Wrangler in once (`npx wrangler login`), and the `infra` commands use its sign-in. `CLOUDFLARE_API_TOKEN` is used instead if it's set, e.g. in CI, and `CLOUDFLARE_ACCOUNT_ID` names the account if your sign-in reaches more than one. How they get there is up to you. The `infra` commands check first that they're set and that the container provider takes them. An `achq.config.ts` beside the infra file can name a command that puts them in the environment, and achq takes on the environment it sets: `export default { env: "op run --env-file=.env --" }`. It plans the container provider's project, the router, the deployer and each channel as one graph, prints what would change, then makes it. An App that doesn't exist yet is created through GitHub's manifest flow in your browser. If `achq.config.ts` gives a vault, `vault: onepassword.vault("<vault>")` from `@achq/1password`, its private key is kept there (with `op`, as you're signed in to it), and the router gets it from the vault, so an App can move to another router or be run from another machine; a key only a router has is refused, not copied into the vault. Without a vault, the key goes straight into the router's variables. On Cloudflare, Workers Builds clones repos with Cloudflare's GitHub App ("Cloudflare Workers and Pages"). Only Cloudflare can tell whether it's installed, so a repo it can't see fails its deploy, with the App's install page in `ACHQ_STATUS`, and `achq repo install` opens it. On Railway, a container builds from its repo through Railway's GitHub App ("Railway App") in the same way: a repo it can't see fails its deploy with that App's install page. Once, it opens your browser to create the deployer's own API token on Cloudflare's create-token page with its permissions filled in: paste it when asked (it isn't echoed). It's checked, then set only as the deployer Worker's secret, never written to disk or kept with the variables; `--rotate-deployer-token` makes a new one. The deployer builds containers with it, with Workers Builds, and never gets your sign-in. It deploys the router and deployer with Wrangler (`npx wrangler@4`), as it's signed in. Then it syncs every installed repo. Re-running it changes only what differs; `--dry-run` shows what would change.

| Service | Exposure | Does |
|---|---|---|
| Router | Public, always on | Receives every App's webhooks, persists them, forwards each to the containers it's for; mints short-lived tokens for containers |
| Deployer | Private, sleeps | Evaluates repo config in a QuickJS sandbox and deploys its containers |
| Container | Private, sleeps | Runs the repo's agents |

## A repo

```ts
// .achq/config.ts
import { Container, Trigger, Workspace } from "@achq/core";
import * as claude from "@achq/claude";
import * as github from "@achq/github";

const channel = github.Channel.get("notation-achq");

const code = new github.Policy("code", { channel, permissions: { contents: "write", issues: "write", pull_requests: "write" } });
const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });

new Workspace("docs", { container: dev, threads: channel.issues.where({ labels: ["docs"] }), branch: "docs-{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: channel.issues, branch: "issue-{number}", base: "main" });

const coder = new claude.Agent("coder", { model: "claude-opus-5-5", effort: "high", systemPrompt: "./prompts/system.md" });
new Trigger("mention", { event: channel.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });
```

- **Container**: an image, the policies its agents get tokens for, and startup files.
- **Workspace**: which threads (issues) are worked on in which container, on which branch. The first matching workspace claims a thread, and keeps it if its labels change.
- **Agent**: model, effort, the repo's system prompt (after achq's runner prompt), settings. Each agent has its own Claude config directory and its own session per thread.
- **Trigger**: an event and an agent. A mention counts in a new comment or issue, or when an edit adds it.

The Dockerfile installs the repo's toolchain and achq:

```dockerfile
FROM node:22.18-bookworm
RUN npm install -g bun@1.4.3
RUN curl -fsSL https://raw.githubusercontent.com/djgrant/achq/main/install.sh | sh
```

It must be Debian-based (the install script uses apt), with `bun` on `PATH`, and tools installed system-wide: the agent runs as the unprivileged `agent` user. It needs no `CMD`: the container provider starts the runner itself, and ignores one. The script installs the system tools the runner needs and `achq-runner`, which runs `@achq/runner` from npm at the version the deployer gives the container, with the plugins the infra declares installed under `/data/plugins`.

Pushing a change to `.achq/` on the default branch redeploys what changed. Only a new container or a changed Dockerfile rebuilds; other changes apply from the next event. Each deploy's outcome is in the repo's `ACHQ_STATUS` variable.

## Using it

| Comment | Does |
|---|---|
| `@claude <prompt>` | Resume the thread's session, or start one |
| `@claude /new <prompt>` | Start a fresh session |
| `@claude /compact [focus]` | Compact the session |

The runner posts the agent's final message as a comment. Only messages from users with write access reach the agent, and it can't read issues itself, so nobody else's text gets in. One run per thread per workspace at a time; comments made during a run are picked up by the next.

## Commands

`pnpm add -g @achq/cli` installs `achq`. It runs on Bun, which must be on your `PATH`. In this repo, `packages/cli/bin/achq` runs the checkout's CLI after `pnpm install`.

| Command | Run from | Does |
|---|---|---|
| `achq infra up [--prune] [--dry-run] [--rotate-deployer-token]` | Infra | Brings the infra in line with `achq.infra.ts`, then syncs installed repos. `--prune` deletes containers of repos no longer installed. `--rotate-deployer-token` replaces the deployer's own token, where it has one (Cloudflare) |
| `achq infra status` | Infra | Every repo's last deploy, and failed deliveries |
| `achq infra replay` | Infra | Sends failed deliveries again |
| `achq infra down [--dry-run] [--yes]` | Infra | Shows what it deletes and asks first: every container, by the deployer syncing to no repos, which deletes each repo's `ACHQ_STATUS`, then the router, the deployer and what they share. Protected resources, e.g. the GitHub App, are listed and left, and it opens where you delete each yourself |
| `achq repo status [--repo]` | Repo | Its `ACHQ_STATUS` |
| `achq repo install [--dry-run]` | Repo | Checks the config, opens GitHub to install its App on the repo, and waits for the deploy. If the deploy needs something only you can do, e.g. install Cloudflare's GitHub App, it opens that, waits for you, and deploys again |
| `achq repo uninstall` | Repo | Opens GitHub to remove the repo from its App's installation, and waits until it's gone, then deletes its `ACHQ_STATUS` with your `gh` login. Its containers are kept, asleep |
| `achq container ssh [--repo] [-- cmd]` | Repo | A shell in the repo's container |
| `achq container resume [n] [session] [--repo]` | Repo | Opens an agent session in its worktree, picked from all of them or issue `n`'s |

`--repo` takes `owner/name` or a URL; without it, the repo is the one `git remote get-url origin` names in the current directory. `install` and `uninstall` ask the router `ACHQ_STATUS` names whether the App is installed on the repo, since your `gh` login can't list installations; a repo that's never been deployed has no router to ask, and one whose router is gone has moved to another hq, so `install` opens the App's install page. `ssh` and `resume` need `gh`, and the Railway CLI, or on Cloudflare Wrangler signed in to the account (`npx wrangler login`) and one of the deployer's `sshKeys`. They ask the router, which wakes the container and has the deployer, which holds the container provider's credentials, answer with the command that opens the shell; anyone who can push to the repo can get it.

## The container

```
/data/home/                           HOME
/data/agents/<agent>/                 each agent's CLAUDE_CONFIG_DIR, with its session transcripts
/data/mirror.git                      bare mirror
/data/config/<commit>/                `.achq/` as of each deployed commit
/data/worktrees/<workspace>/<thread>  one worktree per thread, left as the agent leaves it
/data/threads/<thread>.json           each agent's session, and the workspace it runs in
/data/github/                         tokens for the container's policies, refreshed before they expire
```

A thread is named from its ID, e.g. `notationlabs-yieldstar-42`.

## Development

Each folder in `packages/` is a workspace package, prefixed with its kind. Packages import each other by name, never by relative path, and each has its tests and their helpers in `test/`.

| Kind | Packages | What it is |
|---|---|---|
| Kernel | `core` | The contracts plugins implement, resources and the engine that plans and applies them, and the wire protocol between achq's services |
| Plugin | `plugin-github`, `plugin-railway`, `plugin-cloudflare`, `plugin-claude`, `plugin-1password` | Implementations of core's contracts for one vendor |
| Service | `service-router`, `service-deployer`, `service-runner` | What runs, each published and started with `bunx` (`bin/`): `main.ts` reads its settings from the environment, installs and loads the plugins `ACHQ_PLUGINS` names with `@achq/core/plugins`' `loadPlugins`, and wires it up from their providers. The services share one file map: `main.ts` reads the environment, builds the context and serves; `context.ts`'s `createContext(env, deps)` builds the context; `store.ts`'s `createStore(stores)` opens its collections, migrated, the only code given the raw `Stores`; `routes.ts`'s `routes(ctx)` serves each `core/src/wire/routes/` declaration it answers on a Hono app, with `utils/routes`' `serve`, which checks the request with `@hono/standard-validator` and the handler's answers against the route, and how they're mounted; and `features/` holds its domain, e.g. the router's `deliveries.ts`, an event's way to its targets, and the deployer's `deploy.ts` and `sync.ts`. The runner, `achq-runner` in each repo container, follows it: `from-env.ts`'s `runnerFromEnv` builds it from the container's environment, `state.ts`, in place of a store, keeps thread state and the deliveries it has handled in local files, `routes.ts`'s `routes(runner)` serves its event route, `commands/` holds one file per command (`serve`, `sessions`, `resume`), and `features/` the runner, the agent process's env, config loading and the data layout |
| Worker | `cloudflare-worker` | The Worker every service and container runs as on Cloudflare, in Cloudflare's runtime rather than Bun: its entry, the lifecycle of its container, and its routes. Its contract with `plugin-cloudflare`, which deploys it, is `@achq/cloudflare-worker/settings` |
| Tool | `cli` | Built on pok, a folder per kind of thing: `main.ts` takes on `achq.config.ts`'s environment and runs pok with `commands.ts`'s list of commands; `commands/` holds one file per command, which runs `tasks/`, one per step that reports, waits, prompts or is shared, named `domain.verb` as commands are (`infra.apply`, `infra.sync`, `repo.install`, `container.reach`, …), each with the timeouts it waits on; `checks/` what's checked before reaching the infra; `envs/` `achq.config.ts`, its `env` command as a pok resolver; `renderers/` and `pickers/` pure functions of what it prints and picks; and `io/` the terminal and where it's run |
| Library | `utils` | Know nothing about achq, and aren't published: each package bundles what it uses. A module per domain, exporting one namespace (`errors`, `json`, `text`, `collections`, `graph`, `async`, `crypto`, `disk`, `subprocess`, `http`, `flock`), or a few (`routes`: what declares, serves and calls a route), or classes where it builds on something (`Env`, `Git`, `GitHub` over Octokit, `Railway`, `Cloudflare`, `JsonDirStore`, `HttpJsonStore`). Callers keep the namespace, `json.from(…)`, `async.retry(…)`, so where a helper comes from is plain |
| Testing | `test-utils`, `test-e2e` | Fakes shared across packages; the whole system end to end |

**Core** is in five parts, one kind of thing per folder: `model/` (achq's domain as data: events, threads, repos, credentials, the manifest, at `@achq/core/manifest`, and the config dir), `resources/` (the `Resource` class, what configs and the infra declare), `engine/` (outputs, `plan` and `apply`, collecting the manifest, and the `Context` outside the sandbox, at `@achq/core/context`), `contracts/` (one file per provider interface, and `Providers`, what a plugin provides), `wire/` (the HTTP protocol between services: its routes, each declared once with `defineRoute`, its requests as Valibot schemas in `@achq/core/protocol`, checked where they arrive, the plain types of those core's contracts use, its constants, how a service installs and loads its plugins, at `@achq/core/plugins`, signing, with the Hono middleware that checks it, and secrets). Published, core is its index alone, with no dependencies: its other entries are for achq's own packages, which bundle what they use of them.

**A resource is one class**: what it's declared with, and, if achq keeps it in shape, how it's read, compared and changed (`ManagedResource`: `read`, `diff`, `describe`, `planned`, `apply`, `check`). A resource made of others returns them from `children`. The router and deployer are core's `Router` and `Deployer`, which keep their groups of variables (and the router's `env`, read through its first group, and variables many resources add to, valued when it's planned with the join their plugin gives, e.g. each channel's App to `ACHQ_GITHUB_APPS`), the variables every service has, and those achq connects them with (`Deployer.connect`); a plugin's subclass gives its `Placement`: how a group of variables is set, its resources and deploy over every group's variables as one map, and its `privateUrl`, with the router's `url`, and, for a deployer that needs them, its container provider's own variables (`providerVariables`, after achq's in the first group). `achq infra up` plans the infra's resources; nothing else knows how they're made.

**A concept has one name on both sides, and one folder in its plugin**: what a config or the infra declares (its resource) takes the concept's name, and the implementation of core's contract that achq's services and CLI call (its provider) is named `<Concept>Provider`, after the contract. A concept without a resource is named after the concept. They live side by side, and a concept folder holds only those:

| File | Holds |
|---|---|
| `resource.ts` | The resource, e.g. `github.Policy` |
| `config.ts` | What a repo's config adopts an infra resource by, when the resource itself imports Node code, e.g. `github.Channel.get` |
| `provider.ts` | The provider, e.g. `GitHubPolicyProvider` |
| `index.ts` | Exports the provider alone, as `providers.ts` lists it |

GitHub's are `channel/` (`github.Channel` and `GitHubChannelProvider`), `policy/` (`github.Policy` and `GitHubPolicyProvider`) and `code-host/` (`github.CodeHost`, `GitHubCodeHostProvider`, the services' side, and `GitHubCodeHostAsYou`, the CLI's, through your `gh` login). Everything else is in the package's one `src/lib/`, a file per topic the concepts share: its Apps and their keys, webhooks, selectors, permissions and so on. The API client itself is `GitHub` in `@achq/utils/gh`, over Octokit. Railway's are `container/` (`RailwayContainerProvider`, whose `shell` is `railway ssh`; the resource is core's `Container`), `router/` (`railway.Router`) and `deployer/` (`railway.Deployer`), which hold only a resource; its `lib/` has Railway's own objects as resources (`Project`, `Service`, `Deployment`, `Variables`), and where one of achq's services runs among them (`service-parts.ts`, its `Placement`). The GraphQL client is `Railway` in `@achq/utils/railway`. Cloudflare's are `container/` (`CloudflareContainerProvider`, whose `shell` is `wrangler containers ssh` to the running instance it finds with Cloudflare's API), `router/` (`cloudflare.Router`) and `deployer/` (`cloudflare.Deployer`); its `lib/` has Cloudflare's own objects as resources (`Project`, its KV namespace and R2 bucket, `Worker`, `Variables`, `Secrets`, `Deployment`, `BuildTrigger`, `DeployerToken`), the deployer's Builds token (`build-token.ts`), where one of achq's services runs among them (`service-parts.ts`, its `Placement`), and how a container is made of them (`container-parts.ts`). The Worker every service and container runs as is its own package, `cloudflare-worker`, which it deploys from its entry and configures through `@achq/cloudflare-worker/settings`. The REST client is `Cloudflare` in `@achq/utils/cloudflare`. Claude's is `agent/` (`claude.Agent`, `claude.AgentRuntime`, the infra's, and `ClaudeAgentProvider`). 1Password's is `vault/` (`OnePasswordVaultProvider`), with `onepassword.vault(name)` at its root for `achq.config.ts`'s `vault`, through `op` in its `lib/`.

Besides its concept folders, a plugin's `src/` has two files:

| File | Holds |
|---|---|
| `plugin.ts` | `PLUGIN`, its package's name and version, read from its `package.json`: every resource it declares carries it |
| `providers.ts` | `providers`, at `./providers`: each provider it has, by kind (`channels`, `policies`, `containers`, `codeHosts`, `agents`), which a process that's given the plugin loads |

Core's and a plugin's `src/index.ts` is what repo configs import: it runs in the deployer's sandbox, so it and everything it imports is typechecked without Bun or Node types (`tsconfig.sandbox.json`). A plugin's `src/infra.ts` is what the infra file imports. A plugin takes `@achq/core` as a peer dependency, so it shares the core of whatever installs it; where a process has two copies anyway, e.g. a CLI installed globally and the infra repo's, core recognises its classes by a brand rather than `instanceof`, and keeps its declarations and `UNKNOWN` once per process.

The services never import a plugin. They use core's contracts, and are given the plugins to load as data: `pluginsOf` collects them from the infra's resources by role (the router and deployer load all but agent runtimes; containers load channels', policies' and runtimes'), `Deployer.connect` sets them as `ACHQ_PLUGINS`, and each process installs its list under its data dir. The CLI reads what it needs off the infra it loaded: its router and deployer's container provider, its code host, its runtimes' variables. The one plugin the CLI imports is GitHub's code host, for repo commands: a repo has no infra file, and its `ACHQ_STATUS`, which names its router, is kept on the code host. Adding a plugin means implementing core's contracts in its concept folders, listing them in `providers.ts`, and declaring resources that carry its `PLUGIN`.

pnpm manages the workspace's packages; Bun runs them and their tests.

```sh
pnpm install
pok test
pok typecheck
```

Releases are lockstep: every published package (every workspace package that isn't private, as the root `pok.config.ts` finds them) has the same version. Each publishes a bundle, which `pok bundle` (`scripts/bundle.ts`) makes in its `dist/`, with its dependencies in it, so installing one installs nothing else, and `publishConfig` points its exports and bins at it. `utils` isn't published: each package that uses it has the part it uses in its bundle. Core isn't bundled into the plugins, which take it as a peer, so a plugin shares the core installed beside it; nor is the Worker into the Cloudflare plugin, which deploys it from where it's installed. Core and the plugins publish declarations for what configs and infra files import (core's index, a plugin's `.` and `./infra`), bundled the same way, so they have no `utils`, and no Valibot: the types core's contracts and plugins' resources use are plain types, which their schemas satisfy. Every schema is Valibot's (`utils/schema` has what they share), but for the CLI's commands' and tasks' params, which pok reads as zod's. `packages/test-e2e/test/bundles.test.ts` packs every package as it's published and uses it as the services, containers, CLI and a config do. `pok version patch` bumps them, commits, tags `v<version>` and pushes; `pok publish` bundles them, then publishes them with pnpm, which turns `workspace:*` into that version (`--dry-run` to see what it would do). The services are published too: the router and deployer start with `bunx @achq/router@<version>` and `bunx @achq/deployer@<version>`, where the version is the infra's `@achq/core`'s, and a container's `achq-runner`, which `install.sh` installs, runs `bunx @achq/runner@$ACHQ_VERSION`, the deployer's version. A container Worker on Cloudflare is built from `@achq/cloudflare-worker`'s npm tarball at that version.

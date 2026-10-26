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
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";

export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  // Runs in its router's Railway project, and puts containers there.
  new railway.Deployer("deployer", { router, owners: ["djgrant", "notationlabs"] });
  new github.Channel("personal", { name: "djgrant-claude", router });
  new github.Channel("notation", { name: "notation-achq", org: "notationlabs", router });
});
```

On Cloudflare, the router and deployer are Workers, each running its service in a container:

```ts
// achq.infra.ts
import { achq } from "@achq/core";
import * as cloudflare from "@achq/cloudflare/infra";
import * as github from "@achq/github/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "achq" });
  // Builds containers with Workers Builds, with a token of its own.
  new cloudflare.Deployer("deployer", { router, owners: ["djgrant", "notationlabs"], sshKeys: ["ssh-ed25519 AAAA… me@laptop"] });
  new github.Channel("personal", { name: "djgrant-claude", router });
});
```

`sshKeys` are public key lines, as in `~/.ssh/id_ed25519.pub`, that the deployer writes into each container Worker's `authorized_keys`. `achq container ssh` and `resume` open a shell with `wrangler containers ssh`, which connects as one of them, with its private key on your machine; a container Worker without any can't be reached that way. Railway doesn't need them: `railway ssh` connects as you're signed in to Railway.

For types, add `@achq/core` and the plugins it imports to the infra repo: `bun add -D @achq/core @achq/railway @achq/github`. A repo's `.achq/config.ts` takes `bun add -D @achq/core @achq/github @achq/claude`. `achq infra up` loads them from the CLI itself, so their versions match it.

`achq infra up` needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in its environment, and its container provider's credentials: `RAILWAY_API_TOKEN` on Railway. On Cloudflare, it needs no API token: sign Wrangler in once (`npx wrangler login`), and the `infra` commands use its sign-in. `CLOUDFLARE_API_TOKEN` is used instead if it's set, e.g. in CI, and `CLOUDFLARE_ACCOUNT_ID` names the account if your sign-in reaches more than one. How they get there is up to you. The `infra` commands check first that they're set and that the container provider takes them. An `achq.config.ts` beside the infra file can name a command that puts them in the environment, and achq takes on the environment it sets: `export default { env: "op run --env-file=.env --" }`. It plans the container provider's project, the router, the deployer and each channel as one graph, prints what would change, then makes it. An App that doesn't exist yet is created through GitHub's manifest flow in your browser. If `achq.config.ts` names a vault, `vault: { provider: "1password", name: "<vault>" }`, its private key is kept there (with `op`, as you're signed in to it), and the router gets it from the vault, so an App can move to another router or be run from another machine; a key only a router has is refused, not copied into the vault. Without a vault, the key goes straight into the router's variables. On Cloudflare, Workers Builds clones repos with Cloudflare's GitHub App ("Cloudflare Workers and Pages"). Only Cloudflare can tell whether it's installed, so a repo it can't see fails its deploy, with the App's install page in `ACHQ_STATUS`, and `achq repo install` opens it. On Railway, a container builds from its repo through Railway's GitHub App ("Railway App") in the same way: a repo it can't see fails its deploy with that App's install page. Once, it opens your browser to create the deployer's own API token on Cloudflare's create-token page with its permissions filled in: paste it when asked (it isn't echoed). It's checked, then set only as the deployer Worker's secret, never written to disk or kept with the variables; `--rotate-deployer-token` makes a new one. The deployer builds containers with it, with Workers Builds, and never gets your sign-in. It deploys the router and deployer with Wrangler (`npx wrangler@4`), as it's signed in. Then it syncs every installed repo. Re-running it changes only what differs; `--dry-run` shows what would change.

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
ARG ACHQ_REF=main
RUN curl -fsSL "https://raw.githubusercontent.com/djgrant/achq/$ACHQ_REF/install.sh" | sh -s "$ACHQ_REF"
```

It must be Debian-based (the install script uses apt), with `bun` on `PATH`, and tools installed system-wide: the agent runs as the unprivileged `agent` user. It needs no `CMD`: the container provider starts the runner itself, and ignores one.

Pushing a change to `.achq/` on the default branch redeploys what changed. Only a new container or a changed Dockerfile rebuilds; other changes apply from the next event. Each deploy's outcome is in the repo's `ACHQ_STATUS` variable.

## Using it

| Comment | Does |
|---|---|
| `@claude <prompt>` | Resume the thread's session, or start one |
| `@claude /new <prompt>` | Start a fresh session |
| `@claude /compact [focus]` | Compact the session |

The runner posts the agent's final message as a comment. Only messages from users with write access reach the agent, and it can't read issues itself, so nobody else's text gets in. One run per thread per workspace at a time; comments made during a run are picked up by the next.

## Commands

`bun add -g @achq/cli` installs `achq`. It runs on Bun, which must be on your `PATH`. In this repo, `packages/cli/bin/achq` runs the checkout's CLI after `bun install`.

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

`--repo` takes `owner/name` or a URL; without it, the repo is the one `git remote get-url origin` names in the current directory. `install` and `uninstall` ask the router `ACHQ_STATUS` names whether the App is installed on the repo, since your `gh` login can't list installations; a repo that's never been deployed has no router to ask, and one whose router is gone has moved to another hq, so `install` opens the App's install page. `ssh` and `resume` need `gh`, and the Railway CLI, or on Cloudflare Wrangler signed in to the account (`npx wrangler login`) and one of the deployer's `sshKeys`. They wake the container through the router first.

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
| Service | `service-router`, `service-deployer`, `service-runner` | What runs: `main.ts` reads its settings from the environment and wires it up from the registry. The services share one file map: `main.ts` reads the environment, builds the context and serves; `context.ts`'s `createContext(env, deps)` builds the context; `store.ts`'s `createStore(stores)` opens its collections, migrated, the only code given the raw `Stores`; `routes.ts`'s `routes(ctx)` serves each `core/src/wire/routes/` declaration it answers as an `OpenAPIHono` app, and how they're mounted; and `features/` holds its domain, e.g. the router's `deliveries.ts`, an event's way to its targets, and the deployer's `deploy.ts` and `sync.ts`. The runner, `achq-runner` in each repo container, follows it: `from-env.ts`'s `runnerFromEnv` builds it from the container's environment, `state.ts`, in place of a store, keeps thread state and the deliveries it has handled in local files, `routes.ts`'s `routes(runner)` serves its event route, `commands/` holds one file per command (`serve`, `sessions`, `resume`), and `features/` the runner, the agent process's env, config loading and the data layout |
| Worker | `cloudflare-worker` | The Worker every service and container runs as on Cloudflare, in Cloudflare's runtime rather than Bun: its entry, the lifecycle of its container, and its routes. Its contract with `plugin-cloudflare`, which deploys it, is `@achq/cloudflare-worker/settings` |
| Tool | `cli` | Built on pok, a folder per kind of thing: `main.ts` takes on `achq.config.ts`'s environment and runs pok; `commands/` holds one file per command, which runs `tasks/`, one per step that reports, waits, prompts or is shared, named `domain.verb` as commands are (`infra.apply`, `infra.sync`, `repo.install`, `container.reach`, …), each with the timeouts it waits on; `checks/` what's checked before reaching the infra; `envs/` `achq.config.ts`, its `env` command as a pok resolver; `renderers/` and `pickers/` pure functions of what it prints and picks; and `io/` the terminal and where it's run |
| Registry | `registry` | `@achq/registry`: one list of implementations per contract, but one code host, `CODE_HOST`; and `@achq/registry/modules`, the packages configs may import (`@achq/core`, `@achq/github`, `@achq/claude`) and those the infra file's imports resolve to (`@achq/core` and each plugin's `/infra`), for the sandbox and the CLI |
| Library | `utils` | Know nothing about achq. A module per domain, exporting one namespace (`errors`, `json`, `text`, `collections`, `graph`, `async`, `crypto`, `disk`, `subprocess`, `http`, `flock`, `sandbox`), or classes where it builds on something (`Env`, `Git`, `GitHub` over Octokit, `Railway`, `Cloudflare`, `JsonDirStore`, `HttpJsonStore`). Callers keep the namespace, `json.from(…)`, `async.retry(…)`, so where a helper comes from is plain |
| Testing | `test-utils`, `test-e2e` | Fakes shared across packages; the whole system end to end |

**Core** is in five parts, one kind of thing per folder: `model/` (achq's domain as data: events, threads, repos, credentials, the manifest, at `@achq/core/manifest`, and the config dir), `resources/` (the `Resource` class, what configs and the infra declare), `engine/` (outputs, `plan` and `apply`, collecting the manifest, and the `Context` outside the sandbox, at `@achq/core/context`), `contracts/` (one file per provider interface), `wire/` (the HTTP protocol between services: its requests as zod schemas in `@achq/core/protocol`, checked where they arrive, its constants, how a service fetches achq's code, signing, with the Hono middleware that checks it, and secrets).

**A resource is one class**: what it's declared with, and, if achq keeps it in shape, how it's read, compared and changed (`ManagedResource`: `read`, `diff`, `describe`, `planned`, `apply`, `check`). A resource made of others returns them from `children`. The router and deployer are core's `Router` and `Deployer`, which keep their groups of variables (and the router's `env`, read through its first group, and variables many resources add to, valued when it's planned with the join their plugin gives, e.g. each channel's App to `ACHQ_GITHUB_APPS`), the variables every service has, and those achq connects them with (`Deployer.connect`); a plugin's subclass gives its `Placement`: how a group of variables is set, its resources and deploy over every group's variables as one map, and its `privateUrl`, with the router's `url`, and, for a deployer that needs them, its container provider's own variables (`providerVariables`, after achq's in the first group). `achq infra up` plans the infra's resources; nothing else knows how they're made.

**A concept has one name on both sides, and one folder in its plugin**: what a config or the infra declares (its resource) takes the concept's name, and the implementation of core's contract that achq's services and CLI call (its provider) is named `<Concept>Provider`, after the contract. A concept without a resource is named after the concept. They live side by side, and a concept folder holds only those:

| File | Holds |
|---|---|
| `resource.ts` | The resource, e.g. `github.Policy` |
| `config.ts` | What a repo's config adopts an infra resource by, when the resource itself imports Node code, e.g. `github.Channel.get` |
| `provider.ts` | The provider, e.g. `GitHubPolicyProvider` |
| `index.ts` | Exports the provider alone, as the registry lists it |

GitHub's are `channel/` (`github.Channel` and `GitHubChannelProvider`), `policy/` (`github.Policy` and `GitHubPolicyProvider`) and `code-host/` (`GitHubCodeHostProvider`, the services' side, and `GitHubCodeHostAsYou`, the CLI's, through your `gh` login). Everything else is in the package's one `src/lib/`, a file per topic the concepts share: its Apps and their keys, webhooks, selectors, permissions and so on. The API client itself is `GitHub` in `@achq/utils/gh`, over Octokit. Railway's are `container/` (`RailwayContainerProvider`, with its shell, `railway ssh`; the resource is core's `Container`), `router/` (`railway.Router`) and `deployer/` (`railway.Deployer`), which hold only a resource; its `lib/` has Railway's own objects as resources (`Project`, `Service`, `Deployment`, `Variables`), and where one of achq's services runs among them (`service-parts.ts`, its `Placement`). The GraphQL client is `Railway` in `@achq/utils/railway`. Cloudflare's are `container/` (`CloudflareContainerProvider`, with its shell, `wrangler containers ssh`), `router/` (`cloudflare.Router`) and `deployer/` (`cloudflare.Deployer`); its `lib/` has Cloudflare's own objects as resources (`Project`, its KV namespace and R2 bucket, `Worker`, `Variables`, `Secrets`, `Deployment`, `BuildTrigger`, `DeployerToken`), the deployer's Builds token (`build-token.ts`), where one of achq's services runs among them (`service-parts.ts`, its `Placement`), and how a container is made of them (`container-parts.ts`). The Worker every service and container runs as is its own package, `cloudflare-worker`, which it deploys from its entry and configures through `@achq/cloudflare-worker/settings`. The REST client is `Cloudflare` in `@achq/utils/cloudflare`. Claude's is `agent/` (`claude.Agent` and `ClaudeAgentProvider`). 1Password's is `vault/` (`OnePasswordVaultProvider`, for `achq.config.ts`'s `vault`), through `op` in its `lib/`.

Core's and a plugin's `src/index.ts` is what repo configs import: it runs in the deployer's sandbox, so it and everything it imports is typechecked without Bun or Node types (`tsconfig.sandbox.json`). A plugin's `src/infra.ts` is what the infra file imports.

The services and the CLI never import a plugin. They use core's contracts and find implementations by id in `@achq/registry`, or for the code host, the one it has. Adding one means implementing the contract in its concept's folder and listing it there.

```sh
bun install
bun test
bun run typecheck
```

Releases are lockstep: every published package (the `PUBLISHED` list in the root `pok.config.ts`) has the same version. They ship their TypeScript source, so there's no build. `pok version patch` bumps them, commits, tags `v<version>` and pushes; `pok publish` publishes them with pnpm, which turns `workspace:*` into that version (`--dry-run` to see what it would do). The services and the test packages aren't published: the router and deployer run achq from GitHub at a commit, and containers install the runner with `install.sh`.

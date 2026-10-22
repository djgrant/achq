# achq

Agent Communications Headquarters.

Mention `@claude` on a GitHub issue and Claude Code works on it in a container on Railway or Cloudflare: it answers questions, edits the issue, and pushes branches and PRs. Each repo declares its own containers, agents and triggers in `.achq/`, and gets them by installing a GitHub App.

The design and the reasons behind it are in [docs/achq-design.md](docs/achq-design.md).

## Layers

- **achq** (this repo): the CLI, the router, the deployer, the container runtime, and the resource library repos and the infra import.
- **ACHQ infra**: a repo with `achq.infra.ts`, declaring the router, the deployer and the GitHub Apps. `achq infra up` runs it.
- **ACHQ repos**: any repo with `.achq/config.ts` and a Dockerfile. Installing one of the infra's Apps on it deploys it.

## The infra

```ts
// achq.infra.ts
import { achq, github, railway } from "achq/infra";

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
import { achq, cloudflare, github } from "achq/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "achq" });
  // Builds containers with Workers Builds; `sshKeys` are what `achq container ssh` connects with.
  new cloudflare.Deployer("deployer", { router, owners: ["djgrant", "notationlabs"], sshKeys: ["ssh-ed25519 AAAA… me@laptop"] });
  new github.Channel("personal", { name: "djgrant-claude", router });
});
```

For types, add the `achq` package to the infra repo.

`achq infra up` needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in its environment, and its container provider's credentials: `RAILWAY_API_TOKEN` on Railway; on Cloudflare, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, a user token that can edit Workers Scripts, Workers KV Storage, Workers R2 Storage, Containers and Workers Builds Configuration. How they get there is up to you. The `infra` commands check first that they're set and that the container provider takes the token. An `achq.config.ts` beside the infra file can name a command that puts them in the environment, and achq takes on the environment it sets: `export default { env: "op run --env-file=.env --" }`. It plans the container provider's project, the router, the deployer and each channel as one graph, prints what would change, then makes it. An App that doesn't exist yet is created through GitHub's manifest flow in your browser. Its private key goes straight into the router's variables and never touches your machine. On Cloudflare, it also opens your browser to install Cloudflare's GitHub App on each owner, which Workers Builds clones repos with (it checks with your `gh` login), and to create the account's Workers Builds token if it has none; it deploys the router and deployer with Wrangler (`npx wrangler@4`). Then it syncs every installed repo. Re-running it changes only what differs; `--dry-run` shows what would change.

| Service | Exposure | Does |
|---|---|---|
| Router | Public, always on | Receives every App's webhooks, persists them, forwards each to the containers it's for; mints short-lived tokens for containers |
| Deployer | Private, sleeps | Evaluates repo config in a QuickJS sandbox and deploys its containers |
| Container | Private, sleeps | Runs the repo's agents |

## A repo

```ts
// .achq/config.ts
import { Container, Trigger, Workspace } from "achq";
import * as claude from "achq/claude";
import * as github from "achq/github";

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
RUN npm install -g bun@1.3.14
ARG ACHQ_REF=main
RUN curl -fsSL "https://raw.githubusercontent.com/djgrant/achq/$ACHQ_REF/install.sh" | sh -s "$ACHQ_REF"
CMD ["achq-agent"]
```

It must be Debian-based (the install script uses apt), with `bun` on `PATH`, and tools installed system-wide: the agent runs as the unprivileged `agent` user.

Pushing a change to `.achq/` on the default branch redeploys what changed. Only a new container or a changed Dockerfile rebuilds; other changes apply from the next event. Each deploy's outcome is in the repo's `ACHQ_STATUS` variable.

## Using it

| Comment | Does |
|---|---|
| `@claude <prompt>` | Resume the thread's session, or start one |
| `@claude /new <prompt>` | Start a fresh session |
| `@claude /compact [focus]` | Compact the session |

The runner posts the agent's final message as a comment. Only messages from users with write access reach the agent, and it can't read issues itself, so nobody else's text gets in. One run per thread per workspace at a time; comments made during a run are picked up by the next.

## Commands

`packages/cli/bin/achq` (put it on your `PATH`; run `bun install` at the root first).

| Command | Run from | Does |
|---|---|---|
| `achq infra up [--prune] [--dry-run]` | Infra | Brings the infra in line with `achq.infra.ts`, then syncs installed repos. `--prune` deletes containers of repos no longer installed |
| `achq infra status` | Infra | Every repo's last deploy, and failed deliveries |
| `achq infra replay` | Infra | Sends failed deliveries again |
| `achq infra down` | Infra | Not implemented yet |
| `achq repo status [--repo]` | Repo | Its `ACHQ_STATUS` |
| `achq repo install [--dry-run]` | Repo | Checks the config, installs its App on the repo, and waits for the deploy |
| `achq repo uninstall` | Repo | Removes the repo from its App's installation. Its containers are kept, asleep |
| `achq container ssh [--repo] [-- cmd]` | Repo | A shell in the repo's container |
| `achq container resume [n] [session] [--repo]` | Repo | Opens an agent session in its worktree, picked from all of them or issue `n`'s |

`--repo` takes `owner/name` or a URL; without it, the repo is the one `git remote get-url origin` names in the current directory. `ssh` and `resume` need `gh`, and the Railway CLI, or on Cloudflare Wrangler signed in to the account (`npx wrangler login`) and one of the deployer's `sshKeys`. They wake the container through the router first.

## The container

```
/data/home/                           HOME
/data/agents/<agent>/                 each agent's CLAUDE_CONFIG_DIR, with its session transcripts
/data/mirror.git                      bare mirror
/data/config/<commit>/                `.achq/` as of each deployed commit
/data/worktrees/<workspace>/<thread>  one worktree per thread, left as the agent leaves it
/data/threads/<thread>.json           the claiming workspace, and each agent's session
/data/github/                         tokens for the container's policies, refreshed before they expire
```

A thread is named from its ID, e.g. `notationlabs-yieldstar-42`.

## Development

Each folder in `packages/` is a workspace package, prefixed with its kind. Packages import each other by name, never by relative path, and each has its tests and their helpers in `test/`.

| Kind | Packages | What it is |
|---|---|---|
| Kernel | `core` | The contracts plugins implement, resources and the engine that plans and applies them, and the wire protocol between achq's services |
| Plugin | `plugin-github`, `plugin-railway`, `plugin-cloudflare`, `plugin-claude` | Implementations of core's contracts for one vendor |
| Service | `service-router`, `service-deployer`, `service-container` | What runs: `main.ts` reads its settings from the environment and wires it up from the registry. Each serves its routes with Hono, and has a module per theme, e.g. the router's `router.ts` is its whole HTTP API and `deliveries.ts` an event's way to its targets |
| Tool | `cli` | `commands/` (one per command), `lib/` (a module per side: `infra`, `repo`, `container`, `workdir`, its own `config`, the `terminal`, and what it prints, `format`) |
| Facade | `achq` | What configs import (`achq`, `achq/github`, `achq/claude`) and what the infra imports (`achq/infra`), and `achq/registry`: one list of implementations per contract |
| Library | `utils` | Know nothing about achq. A module per domain, exporting one namespace (`errors`, `json`, `text`, `collections`, `graph`, `async`, `crypto`, `disk`, `subprocess`, `http`, `flock`, `sandbox`), or classes where it builds on something (`Env`, `Git`, `GitHub` over Octokit, `Railway`, `Cloudflare`, `JsonDirStore`, `HttpJsonStore`). Callers keep the namespace, `json.from(…)`, `async.retry(…)`, so where a helper comes from is plain |
| Testing | `test-utils`, `test-e2e` | Fakes shared across packages; the whole system end to end |

**Core** is in four parts: `resources/` (the `Resource` class, what configs and the infra declare), `engine/` (outputs, `plan` and `apply`), `contracts/` (one file per contract), `wire/` (the HTTP protocol between services: its requests as zod schemas in `@achq/core/protocol`, checked where they arrive, its constants, signing, with the Hono middleware that checks it, and secrets).

**A resource is one class**: what it's declared with, and, if achq keeps it in shape, how it's read, compared and changed (`ManagedResource`: `read`, `diff`, `describe`, `planned`, `apply`, `check`). A resource made of others returns them from `children`. `achq infra up` plans the infra's resources; nothing else knows how they're made.

**A concept has one name on both sides, and one folder in its plugin**: what a config or the infra declares (its resource) takes the concept's name, and the implementation of core's contract that achq's services and CLI call (its provider) is named `<Concept>Provider`, after the contract. A concept without a resource is named after the concept. They live side by side, and a concept folder holds only those:

| File | Holds |
|---|---|
| `resource.ts` | The resource, e.g. `github.Policy` |
| `config.ts` | What a repo's config adopts an infra resource by, when the resource itself imports Node code, e.g. `github.Channel.get` |
| `provider.ts` | The provider, e.g. `GitHubPolicyProvider` |
| `index.ts` | Exports the provider alone, as the registry lists it |

GitHub's are `channel/` (`github.Channel` and `GitHubChannelProvider`), `policy/` (`github.Policy` and `GitHubPolicyProvider`) and `code-host/` (`github.CodeHost`, the config's App installed on a repo, which `achq repo install` and `uninstall` plan, and `GitHubCodeHostProvider`). Everything else is in the package's one `src/lib/`, a file per topic the concepts share: its Apps and their keys, webhooks, selectors, permissions and so on. The API client itself is `GitHub` in `@achq/utils/gh`, over Octokit. Railway's are `container/` (`RailwayContainerProvider`, with its shell, `railway ssh`; the resource is core's `Container`), `router/` (`railway.Router`) and `deployer/` (`railway.Deployer`), which hold only a resource; its `lib/` has Railway's own objects as resources (`Project`, `Service`, `Deployment`, `Variables`), and how a service is made of them (`service-parts.ts`). The GraphQL client is `Railway` in `@achq/utils/railway`. Cloudflare's are `container/` (`CloudflareContainerProvider`, with its shell, `wrangler containers ssh`), `router/` (`cloudflare.Router`) and `deployer/` (`cloudflare.Deployer`); its `lib/` has Cloudflare's own objects as resources (`Project`, its KV namespace and R2 bucket, `Worker`, `Variables`, `Secrets`, `Deployment`, `BuildTrigger`, `BuildToken`, `BuildsGitHubApp`), and how a service and a container are made of them (`service-parts.ts`, `container-parts.ts`). Its `worker/` is the Worker every service and container runs as, in Cloudflare's runtime rather than Bun: its entry, the lifecycle of its container, and its routes. The REST client is `Cloudflare` in `@achq/utils/cloudflare`. Claude's is `agent/` (`claude.Agent` and `ClaudeAgentProvider`).

`src/index.ts` is what repo configs import: it runs in the deployer's sandbox, so it and everything it imports is typechecked without Bun or Node types (`tsconfig.sandbox.json`). `src/infra.ts` is what the infra file imports.

The services and the CLI never import a plugin. They use core's contracts and find implementations by id in `achq/registry`. Adding one means implementing the contract in its concept's folder and listing it there.

```sh
bun install
bun test
bun run typecheck
```

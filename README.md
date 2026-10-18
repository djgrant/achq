# achq

Agent Communications Headquarters.

Mention `@claude` on a GitHub issue and Claude Code works on it in a container on Railway: it answers questions, edits the issue, and pushes branches and PRs. Each repo declares its own containers, agents and triggers in `.achq/`, and gets them by installing a GitHub App.

The design and the reasons behind it are in [docs/achq-design.md](docs/achq-design.md).

## Layers

- **achq** (this repo): the CLI, the router, the deployer, the container runtime, and the resource library repos and the infra import.
- **ACHQ infra**: a repo with `achq.infra.ts`, declaring the router, the deployer and the GitHub Apps. `achq up` runs it.
- **ACHQ repos**: any repo with `.achq/config.ts` and a Dockerfile. Installing one of the infra's Apps on it deploys it.

## The infra

```ts
// achq.infra.ts
import { achq } from "achq";
import * as github from "achq/github";
import * as railway from "achq/railway";

export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  const deployer = new railway.Deployer("deployer", {
    project: "achq",
    router,
    containerHost: railway.containerHost({ project: "achq" }),
    owners: ["djgrant", "notationlabs"],
  });
  new github.App("personal", { name: "djgrant-claude", router, deployer });
  new github.App("notation", { name: "notation-achq", org: "notationlabs", router, deployer });
});
```

`achq up` needs `RAILWAY_API_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in its environment; how they get there is up to you (`op run`, direnv, …). It creates or updates, in order: the Railway project, the router, the deployer, and each App. An App that doesn't exist yet is created through GitHub's manifest flow in your browser. Its private key goes straight into the router's Railway variables and never touches your machine. Then it syncs every installed repo. Re-running it changes only what differs; `--dry-run` shows what would change.

| Service | Exposure | Does |
|---|---|---|
| Router | Public, always on | Receives every App's webhooks, persists them, forwards each to the containers it's for; mints short-lived tokens for containers |
| Deployer | Private, sleeps | Evaluates repo config in a QuickJS sandbox and deploys its containers |
| Container | Private, sleeps | Runs the repo's agents |

## A repo

```ts
// .achq/config.ts
import { Claude, Container, Trigger, Workspace } from "achq";
import * as github from "achq/github";

const app = github.App.get("notation-achq");

const code = new github.RepoPolicy("code", { app, permissions: { contents: "write", issues: "write", pull_requests: "write" } });
const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });

new Workspace("docs", { container: dev, threads: app.issues.where({ labels: ["docs"] }), branch: "docs-{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: app.issues, branch: "issue-{number}", base: "main" });

const coder = new Claude("coder", { model: "claude-opus-5-5", effort: "high", systemPrompt: "./prompts/system.md" });
new Trigger("mention", { event: app.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });
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
| `achq up [--prune] [--dry-run]` | Infra | Brings the infra in line with `achq.infra.ts`, then syncs installed repos. `--prune` deletes containers of repos no longer installed |
| `achq status` | Infra or repo | From the infra: every repo's last deploy. From a repo: its `ACHQ_STATUS` |
| `achq install [--dry-run]` | Repo | Checks the config, installs its App on the repo, and waits for the deploy |
| `achq uninstall` | Repo | Removes the repo from its App's installation. Its containers are kept, asleep |
| `achq ssh [-- cmd]` | Repo | A shell in the repo's container |
| `achq resume <n> [session]` | Repo | Opens issue `n`'s session in its worktree |

`ssh` and `resume` need the Railway CLI and `gh`. They wake the container through the router first.

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

Each folder in `packages/` is a workspace package. Packages import each other by name, never by relative path, and each has its tests and their helpers in `test/`.

| Kind | Packages | Layout |
|---|---|---|
| Kernel | `core` | `model/` (resources, plain data), `contracts/` (the interfaces platforms implement, the HTTP protocol), `secrets.ts`, `constants.ts` |
| Provider | `github`, `railway`, `claude` | `resources.ts` (what config or the infra declares), `runtime/` (implementations of core's interfaces), `api.ts` (the platform's API client). Entries: `.`, `/runtime`, `/api` |
| Service | `router`, `deployer`, `container` | `main.ts` (reads the service's settings from the environment and wires it up), its logic, `store.ts`, `clients/` |
| Library | `sandbox`, `flock` | Know nothing about achq |
| Tool | `cli` | `commands/`, `lib/` |
| Facade | `achq` | What repos and the infra import: `achq`, `achq/github`, `achq/railway` |
| Testing | `test-utils`, `e2e` | Fakes shared across packages (`@achq/test-utils/github`, …); the whole system end to end |

Code that runs in the config sandbox (everything `achq` and `achq/github` import) is typechecked without Bun or Node types (`tsconfig.sandbox.json`).

```sh
bun install
bun test
bun run typecheck
```

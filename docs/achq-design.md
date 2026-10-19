---
samepage:
  page: A3
  format: pageless
---
# ACHQ design

Decisions behind achq: one router, many Apps, repos that declare their own agents. Built; see "Not yet verified" for what has only run against fakes.

## Layers

- **ACHQ library**: The CLI, the router, the deployer, the agent, and the resource library. Nothing user-specific. npm-ready (correct `bin` and `exports`) but not published; `packages/cli/bin/achq` stays for putting on `PATH`.
- **ACHQ infra**: Declares the router, deployer and Apps as resources. Reads secrets from its environment; how they get there (`op run`, direnv, CI, a `.env` file) is up to the user.
- **ACHQ repos**: `.achq/config.ts` and an image. Defines the conditions an agent works in, and the events on which it is dispatched.

## Resources

Both the infra and repos are written as a resource graph, Pulumi-shaped: resources take other resources as inputs, and those inputs are the bindings. achq has its own small resource model: each resource can `diff` against what exists and `apply`. A dry run stops after the diff.

### The infra

```ts
// achq.infra.ts, at the infra repo's root
export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  new railway.Deployer("deployer", { router, owners: ["djgrant", "notationlabs"] });
  new github.Channel("personal", { name: "djgrant-claude", router });
  new github.Channel("notation", { name: "notation-achq", org: "notationlabs", router });
});
```

- **Router**: receives events and wakes the deployer and containers.
- **Deployer**: creates and updates containers, in its router's Railway project.
- **A GitHub channel** is a GitHub App, bound to the router. GitHub is both a channel and a policy provider (see Primitives). The App's webhook points at the router, and the router holds the App's key to check deliveries and mint tokens. The App's installations decide which repos the deployer serves.
- **Contracts**: GitHub implements three of core's contracts, each registered on its own: a `ChannelProvider` (events, threads, replies; the router also gets its sources from it), a `PolicyProvider` (turns policies into credentials), and a `CodeHostProvider` (reads `.achq/`, writes the status, gives the clone URL; the router uses it to check `/wake` and to list the repos installed, the CLI for the repo commands, and to install and uninstall a repo). Installation isn't a contract of its own: it's a repo's lifecycle on its code host, set up for achq or not. For GitHub, a repo is installed when the config's App is installed on it. The router gets them with the key, the container without secrets. The infra's channels are resources `achq up` plans. Claude implements `AgentProvider` (`ClaudeAgentProvider`): the runtime, and the variables every container needs. Configs declare its agents as `claude.Agent`, from `achq/claude`. The services and CLI find each one by id in `achq/registry`.
- **The container provider**: the router and deployer name the container provider they run on (`containerProvider`), and the deployer puts containers on the same one. A plugin provides the router and deployer as resources for `achq up`, and implements core's `ContainerProvider` for the deployer, with a shell into containers for `achq ssh` and `resume`. achq's services and CLI only use that contract, and pick an implementation by id. Only Railway is built for now. Putting the router, deployer and containers on different container providers needs bindings this design assumes away: reaching containers without a private network, and waking them through the container provider's API.
- **`owners`**: the deployer only serves repos owned by these accounts. A public App can be installed by anyone, and without this a stranger's install would get a container on your Railway account running on your Claude token.

### A repo

```ts
// .achq/config.ts
import { Container, Workspace, Trigger } from "achq";
import * as claude from "achq/claude";
import * as github from "achq/github";

const channel = github.Channel.get("notation-achq");

const code = new github.Policy("code", { channel, permissions: { contents: "write", issues: "write", pull_requests: "write" } });

const dev = new Container("dev", {
  image: "./Dockerfile",
  policies: [code],
  files: { "~/.config/foo.toml": "./foo.toml" },
});

new Workspace("docs", { container: dev, threads: channel.issues.where({ labels: ["docs"] }), branch: "docs-{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: channel.issues, branch: "issue-{number}", base: "main" });

const coder = new claude.Agent("coder", { model: "claude-opus-5-5", effort: "high", systemPrompt: "./prompts/system.md", settings: { /* … */ } });
const triage = new claude.Agent("triage", { model: "claude-haiku-5-5", systemPrompt: "./prompts/triage.md" });

new Trigger("mention", { event: channel.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });
new Trigger("triage", { event: channel.issue({ actions: ["opened"] }), agent: triage });
```

- Resources take config. The framework decides how to apply it (files, flags, directories).
- Every resource has a name. Names are identities: in plans, in `resume`, and in session keys.
- A repo **adopts** a channel by its App's slug with `github.Channel.get`. It's typed as a GitHub channel, so every GitHub event and permission is typed, but not which ones this App has enabled. That's checked at runtime against the live App (see Checks).
- The trigger (`mention`) belongs to the repo, not the ACHQ infra.
- Events, thread selectors and policies must be plain data, because they cross into the router: it filters on events without waking anything, and mints credentials for policies. Agent settings can be code.

## Primitives

| Primitive | Declared | What it is |
|---|---|---|
| **Channel** | No: provided, e.g. by a GitHub App | Where threads live. Hears events, reads a thread, posts replies, and says which messages are trusted. |
| **Thread** | No: lives in the channel | A GitHub issue, a Linear issue |
| **Policy** | Yes | What a container can access |
| **Container** | Yes | An image, its policies, startup files and a volume |
| **Workspace** | Yes | Which threads are worked on in which container, and how each thread's worktree is set up |
| **Agent** | Yes | Who does the work: model, effort, prompts, settings |
| **Trigger** | Yes | When an agent acts: an event and an agent |

An event finds its container through its thread: event → thread (issue 42) → the workspace that claims it → that workspace's container. The trigger says when and who; the workspace says where.

### Channels and threads

- A GitHub App is both a channel and a policy provider. Others needn't be: Linear would be a channel, with code access still through a GitHub App's policy, and optionally a policy provider for Linear's own API.
- Listening and replying stay one interface. A reply goes to the thread it came from. Sending somewhere else, such as a Slack notification, would be an extra output on an agent, not half a channel.
- Each channel defines who's trusted. For GitHub: users with write access. Only trusted messages go into the prompt.
- Threads are keyed by channel, e.g. `github:notationlabs/yieldstar#42` or `linear:ENG-123`.
- A thread selector (`channel.issues`, `channel.issues.where({ labels: ["docs"] })`) is a plain-data description of which threads match, not a list.

### Containers

- A repo can define several containers. A policy can be passed to several.
- `files` are written at startup. Agent config is applied the same way, per agent.

### Workspaces

- A workspace is a thread's working state in a container: its worktree, its lock, and a session per agent.
- `branch` and `base` set up the worktree the first time the thread appears. A branch can't be named under another branch (`docs/42` next to `docs`): git can't hold both refs.
- Several workspaces can claim the same kind of thread with filters. Declaration order decides; the first match wins, and one with no filter catches the rest.
- A thread sticks to the workspace that claimed it first, so relabelling an issue doesn't move it to another branch.
- Workspaces in two containers can claim the same thread; events on it then run in both. Each replies on the thread as the same App, and branch templates should differ so they don't push to the same branch.
- One run per thread per workspace at a time, across all agents, since they share the worktree.

### Agents

- Agents are reusable: one agent can be attached to several triggers.
- Each agent has its own Claude config directory, so agents in one container can have different settings.
- **Prompts**: achq's runner prompt, which describes how the runner works (the final message is posted as the reply; the agent can't comment or read issues itself), is always applied. Everything else comes from the repo. The infra has no prompts.
- **Sessions**: each agent has its own Claude session per thread, shared across the triggers it's attached to. The session key is a hash of everything in the cached prefix: the agent's name and config, the resolved system prompt (runner prompt and the repo's), and the container's and agent's startup files. Changing any of them starts a fresh session rather than resuming with changed config, which would break caching. An achq update that changes the runner prompt starts fresh sessions everywhere. Claude Code's own version isn't pinned or keyed; if its built-in prompt changes, the cache misses once.
- Replies all come from the App. They aren't labelled with the agent.

### Triggers

- A trigger is an event and an agent. It doesn't name a container or a workspace.
- A trigger whose events no workspace's threads cover never runs. The deployer reports it.

### Policies and policy providers

A policy is plain data, e.g. `{ provider: "github", source: "notation-achq", repos: [...], permissions: {...} }`. A repo can also grant access to other repos, or to another service's API:

```ts
new github.Policy("shared", { channel, repo: "notationlabs/shared", permissions: { contents: "read" } });
new linear.ApiPolicy("linear", { workspace: "notation" });   // Linear's whole workspace: it can't be narrowed
```

A policy provider is code with a part for each side:

```ts
definePolicyProvider({
  id: "github",
  validate: async (policy, ctx) => {},                     // router: the policy is within what the policy provider allows
  mint: async (policy, secret) => ({ value, expiresAt }),  // router: holds the secret, mints a credential
  install: async (credential, dir) => {},                  // container: makes the credential usable by the agent
});
```

- The router and the container load the same policy provider code and each calls its own part. The container having `mint` doesn't matter: the code is public, and without the router's secret it fails.
- **Policy providers come from achq or the infra repo, never from subscriber repos.** A repo only refers to policy providers that exist; its policies reach the router as data. A repo-supplied policy provider would run repo code in the router, next to every App's key.
- A repo's policies always name their source. The deployer's own policy (`deployerPolicy(repo)`: read `.achq/`, write the status) doesn't: for GitHub, the router's policy provider mints it through whichever App is installed on the repo.
- The deployer runs `validate` on every policy at deploy time. For GitHub: the App is installed on the repos, their owner is in `owners`, and the permissions are within the App's. Failures go to `ACHQ_STATUS`.
- GitHub policies under one installation become one token covering their repos. Policies across installations get separate tokens, which git picks between with `credential.useHttpPath`.
- A policy decides what untrusted content the agent could fetch itself (a token with `issues` can read anyone's comments). Not guarded beyond Claude Code's own tool denials.

## Running repo config

Repo config is code. It never runs anywhere that holds secrets.

1. The deployer downloads `.achq/` from the default branch, with a repo-scoped token from the router, minted through whichever App is installed on the repo.
2. It strips the types from each file on its own with `Bun.Transpiler`, with macros off. That doesn't run the config's code.
3. It runs the files as ES modules in QuickJS compiled to WebAssembly, which has no filesystem, network or environment access. The only modules there are the repo's `.achq/` files and a prebuilt `achq` (`achq`, `achq/github`, `achq/claude`), so any other import fails. A Bun subprocess isn't enough: it runs as the same user and could read the deployer's secrets from `/proc/<pid>/environ`.
4. The config returns a plain-data manifest: every resource and its inputs. The deployer creates the containers and pushes events, thread selectors and policies to the router. Each container runs its own config again at runtime for the agent settings, which can be code.

Config can only import `achq`, `achq/github`, `achq/claude` and its own files under `.achq/`.

In the container, the config runs natively (step 4), in the runner's process. That process holds the container secret, so code in the repo's own `.achq/` can mint the container's credentials, including the runner's channel credential. Anyone who can push to the default branch can already change what the agent does, so this doesn't widen who can act, but it's an exception to "never runs anywhere that holds secrets". Running it in a separate process without the secret would close it.

## Services

| Service | Exposure | Holds | Does |
|---|---|---|---|
| Router | Public, always on | `AGENT_WEBHOOK_KEY`, App private keys, router config | Receives every App's webhooks, filters them, forwards them; mints installation tokens for containers |
| Deployer | Private, sleeps when idle; the router wakes it | Railway token, Claude token | Evaluates repo config, creates and updates containers |
| Container | Private, sleeps when idle | Claude token, its current credentials | Runs agents |

## Webhooks

- Each App's webhook points at the router. There are no repo webhooks; deploys delete old ones.
- Each App's webhook secret is derived from `AGENT_WEBHOOK_KEY` and the App ID. GitHub sends the App ID in `X-GitHub-Hook-Installation-Target-ID`, so the router can check any App's deliveries without a list of Apps.
- For `edited` events, a mention only counts if it wasn't in the text before the edit (`changes.body.from`).

## Router config

- The deployer pushes the router's config to an endpoint signed with `AGENT_WEBHOOK_KEY`. The router stores it on a small volume, so it changes without a redeploy.
- The config says which repos are deployed, and each repo's triggers and workspaces. The router drops everything else, so it doesn't wake containers that would ignore the event. The container checks again.

## Persisted events

The router writes every event it accepts to its volume before answering GitHub, so a crash or restart doesn't lose it.

- Each accepted delivery is written to `inbox/<delivery-id>.json`, then forwarded. It's deleted once its target answers.
- On startup the router replays everything left in `inbox/`.
- A delivery that runs out of retries moves to `failed/`, for inspection and replay by hand.
- A crash between forwarding and deleting means a delivery can arrive twice. Containers and the deployer ignore a delivery ID they've already handled.
- This isn't a queue: there's no ordering, priority or backpressure. That stays deferred.

## App keys

- An App is added by declaring its channel in the ACHQ infra. `up` notices it has no credentials and runs GitHub's manifest flow.
- `up` writes the App's private key straight to the router's Railway variables. It never touches the local machine. The ACHQ infra's local environment only needs the Railway token and the Claude token.
- Anything else that needs an App key goes through the router's signed endpoint.

## Credentials

How GitHub's credentials work. Other channels and policy providers follow the same pattern where they can.

- Containers never hold App private keys. They ask the router for credentials for their policies.
- The token endpoint listens on a second port with no public domain, so only the private network reaches it.
- A container proves its identity with a secret derived from `AGENT_WEBHOOK_KEY` and its repo and container name. The router only mints credentials for that container's policies.
- Tokens last an hour. A container fetches one when it starts, then refreshes in the background when 30 minutes remain, so a failed refresh retries for half an hour before anything breaks. A stored token with more than 30 minutes left is reused on wake.
- The token is stored on the container's volume at `/data/github/` (mode `600`). Claude can read it, which is acceptable because it's scoped to the container's policies and expires within an hour.
- Accepted risk: the App keys sit on the public router. A bug in its webhook handling would expose them. The router is small and only parses JSON and checks signatures.

## Subscribing

Installing a repo on its code host subscribes it; uninstalling unsubscribes it. On GitHub, that's installing one of the infra's Apps on it, with `achq install` or from GitHub's settings.

- **Install:** the deployer evaluates the repo's config and deploys its containers, if the repo's owner is in `owners`.
- **Uninstall:** the repo is removed from the router config, so events stop reaching it. Its containers and volumes are kept, asleep, costing only storage. Reinstalling adds it back and everything is as it was.
- **Deletion** is explicit: `achq up --prune` deletes the containers and volumes of repos no longer installed. Railway can't restore a deleted service, and a deleted volume only through an emailed link within 48 hours, so achq never deletes on an event.

- The router forwards `installation` and `installation_repositories` events to the deployer whether or not the repo is deployed yet, since a repo isn't deployed until its install is handled.
- Installing on many repos at once arrives as one event listing them all. The deployer handles them one by one, each with its own `ACHQ_STATUS`.

- The deployer handles install and uninstall events as they arrive (`achq install` waits on the result), and `achq up` syncs too, to catch anything missed.

## Config changes

The App owns the whole lifecycle, including keeping a repo's deployment in line with its config.

- The App subscribes to `push`. The router forwards to the deployer pushes to a deployed repo's default branch that touch `.achq/`. A push payload's commit list is capped for very large pushes (2048 commits, per GitHub's webhook docs), so a push that hits the cap is forwarded whatever it touches.
- The deployer compares the `.achq/` tree at the new head with the one it last deployed. If it's the same, it stops.
- Otherwise it evaluates the config again and compares the resulting manifest with the deployed one. It redeploys only what changed: a container whose image or policies changed is rebuilt; router config is updated for triggers and workspaces.
- The deployer starts builds itself; Railway's auto-deploy is turned off. A container is only rebuilt when it's new, or its image path or Dockerfile changed.
- Everything else in the config reaches containers without a rebuild: the router forwards each event with the commit its config came from, and the container loads that commit's `.achq/` from its mirror (cached per commit).
- Containers removed from the config are handled like uninstalls: kept asleep, deleted only by `achq up --prune`.
- The outcome goes to `ACHQ_STATUS`.

## Checks

The types can't know which events and permissions an App has enabled, so they're checked against the live App:

| When | Who | Checks against | On failure |
|---|---|---|---|
| `achq install --dry-run`, and `install` | CLI, with your `gh` login | `GET /apps/{slug}` | Refuses to install and lists what's missing |
| Deploy | Deployer, through the router | The App's settings, read as the App | Doesn't deploy; writes why to `ACHQ_STATUS` |
| Container start | Container, through the router | The App's settings | Logs triggers the App doesn't send |

- The deploy check is the authoritative one.
- `GET /apps/{slug}` returns 404 for a private App, even to its owner's `gh` login (checked against `djgrant-claude`). For private Apps the CLI check skips the App comparison and only checks the repo's own config.

## Deploy results

Installing is done to a repo, from its settings or with `achq install`, not to a commit. So the deployer reports each deploy's outcome on the repo, in a repository variable, `ACHQ_STATUS`:

```json
{ "state": "failed", "at": "2026-10-17T10:02:00Z", "error": "container default wants issue_comment, which notation-achq doesn't send" }
```

- `achq install` installs the App, then polls `ACHQ_STATUS` with your `gh` login until it shows a result newer than the install, or times out.
- `achq status` from a repo reads the same variable, so it reports a failed install made from the repo's settings. From the infra, it reads the deployer's own records for every repo.
- The App needs the "Variables: write" permission (`actions_variables`). Containers don't get it: their tokens only carry their own permissions.

## Commands

| Command | Run from | Does |
|---|---|---|
| `achq up [--prune] [--dry-run]` | Infra | Brings the infra's resources in line with its code, and is safe to re-run: router and its config, deployer, each channel's App (creating any that are missing) and its webhook settings, then syncs installed repos |
| `achq status` | Infra or repo | From the infra: every installed or deployed repo, its state, when it last deployed, and its containers. From a repo: its `ACHQ_STATUS` |
| `achq install [--dry-run]` | Repo | Reads the repo's config, checks it, and installs the repo on its code host: on GitHub, the App its policies name, after checking it sends and allows what the config needs, then waits for the deploy's outcome in `ACHQ_STATUS`. Opens GitHub's install page if the App has no installation on the account yet. |
| `achq uninstall` | Repo | Removes the repo from its App's installation; the uninstall flow above follows |
| `achq ssh` | Repo | As now |
| `achq resume <n> [session]` | Repo | Opens a thread's session. With one session it opens it; otherwise it lists them (ID, agent, last run) as a picker, or prints the list when not interactive. |

These replace `app`, `deploy` and `destroy`.

## Not yet verified

Every part has run together in one process (`packages/test-e2e/test/e2e.test.ts`) against a fake GitHub, a fake container provider and a fake `claude`. Not yet run for real:

- Railway: turning off auto-deploy with `serviceInstanceAutoDeployUpdate`, the router and deployer start command, sleeping and waking over the private network.
- GitHub: the manifest flow and `PATCH /app/hook/config` on a new App, minting with `actions_variables`, installing with `gh`'s token.
- The container image: `install.sh`, the `perl`-based lock, Claude Code's `--effort` and `CLAUDE_CONFIG_DIR`.

## Deferred

- A real queue between the router and containers: ordering, backpressure. The router's persisted events cover crashes and restarts.
- Hosting the router, deployer and containers on different container providers.
- Channels and policy providers other than GitHub.

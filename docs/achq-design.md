---
samepage:
  page: A3
  format: pageless
---
# ACHQ design

Decisions behind achq: one router, many Apps, repos that declare their own agents. Built; see "Not yet verified" for what has only run against fakes.

## Layers

- **ACHQ library**: The CLI, the router, the deployer, the agent, and the resource library. Nothing user-specific. npm-ready (correct `bin` and `exports`) but not published; `packages/cli/bin/achq` stays for putting on `PATH`.
- **ACHQ infra**: Declares the router, deployer and Apps as resources. Reads secrets from its environment; how they get there (`op run`, direnv, CI, a `.env` file) is up to the user. The CLI's own config, `achq.config.ts`, can name a command that sets them, whose environment the CLI takes on.
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
- **Deployer**: creates and updates containers, in its router's project on their container provider.
- **A GitHub channel** is a GitHub App, bound to the router. GitHub is both a channel and a policy provider (see Primitives). The App's webhook points at the router, and the router holds the App's key to check deliveries and mint tokens. The App's installations decide which repos the deployer serves.
- **Contracts**: GitHub implements three of core's contracts, each registered on its own: a `ChannelProvider` (events, threads, replies; the router also gets its sources from it. Its `parse` makes a delivery an event on a thread, a `ChannelEvent`, for containers, or a `RepoEvent`, which repos to deploy and which to uninstall, for the deployer, tagged with which it's for), a `PolicyProvider` (turns policies into credentials), and a code host, in two halves by who's acting: the services' `CodeHostProvider`, made from their env (the deployer reads `.achq/` and writes the status with it, containers get the clone URL, and the router checks `/wake` against it, lists the repos installed, and says whether a config's App is installed on a repo), and the CLI's `CodeHostAsYou`, acting as you through your `gh` login (finds the repo, reads and deletes `ACHQ_STATUS`, and for installing, names the config's App, checks it, and says where to install it). Installation isn't a contract of its own: it's a repo's lifecycle on its code host, set up for achq or not. For GitHub, a repo is installed when the config's App is installed on it. The router gets them with the key, the container without secrets. The infra's channels are resources `achq infra up` plans. Claude implements `AgentProvider` (`ClaudeAgentProvider`): the runtime, and the variables every container needs. Configs declare its agents as `claude.Agent`, from `achq/claude`. The services and CLI find each one by id in `achq/registry`, except the code host: an infra has one, the registry's `CODE_HOST` (GitHub), where every repo it serves lives and achq's own code too, so a repo is its `owner/name` alone, compared case-insensitively.
- **The container provider**: the router and deployer name the container provider they run on (`containerProvider`), and the deployer puts containers on the same one. A plugin places the router and deployer for `achq infra up`: core's `Router` and `Deployer` keep their variables, in groups (`variables`, `variables-2`, …), with what every service has (ACHQ_DATA_DIR, PORT), the router's generated `AGENT_WEBHOOK_KEY` (unknown in a plan until it's set, so a known key means the router exists; then kept), the container provider's own variables the plugin's subclass gives (`providerVariables`, e.g. the deployer's token), and how achq connects them (`Deployer.connect`: each one's URL, the key, the owners, ACHQ_REF, what every container gets); the plugin's `Placement` sets each group where its container provider keeps variables, deploys over them all as one map, and gives `privateUrl`. It also implements core's `ContainerProvider` for the deployer, with a shell into containers for `achq container ssh` and `resume`. achq's services and CLI only use that contract, and pick an implementation by id. Railway and Cloudflare are built. A container provider offers what the contract's comments ask: a DATA_DIR that outlives restarts and sleep, a store for the router and deployer that keeps a write once it resolves (`store`), URLs only achq's services reach (`privateUrl`, and the one `ensure` returns) that wake what they reach, and sleeping when idle unless kept awake. Railway has a private network and volumes for them; Cloudflare makes them itself (see On Cloudflare). Putting the router, deployer and containers on different container providers needs bindings this design assumes away: reaching one provider's services from another's, and waking them through the container provider's API.
- **`owners`**: the deployer only serves repos owned by these accounts. A public App can be installed by anyone, and without this a stranger's install would get a container on your account running on your Claude token.

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
- Each channel defines who's trusted: it marks each event's actor trusted or not, and a bot or not. For GitHub: users with write access, on an issue opened by one. Only trusted messages go into the prompt.
- Only a trusted person, not a bot, starts a run. That's achq's rule, not the channel's: the router wakes no container for anyone else, and the container checks again. A trigger's selector only says which events it's for.
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
- Only the router decides and records claims. It claims the thread for each container's workspace when it routes an event there, before anything else can route one, so concurrent events on a thread go to the same workspace; the claim is written to the store once the event is in the inbox (a failed write is logged, the claim held in memory and the event still forwarded) and undone if the event never gets there. It forwards the event naming that workspace; the container works the thread there. A claim on a workspace the config no longer has gives way to the first that matches now. Claims are kept when a repo is uninstalled, so reinstalling brings them back.
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
4. The config returns a plain-data manifest: every resource and its inputs, which refer to each other by name. Outside the sandbox, the deployer checks it against a strict schema, as the config could forge it: no unknown keys, size limits, names unique per kind, every name referred to declared, and at least one container. Then it creates the containers and pushes events, thread selectors and policies to the router. Each container runs its own config again at runtime for the agent settings, which can be code.

Config can only import `achq`, `achq/github`, `achq/claude` and its own files under `.achq/`.

In the container, the config runs natively (step 4), in the runner's process, and its manifest gets the same checks. That process holds the container secret, so code in the repo's own `.achq/` can mint the container's credentials, including the runner's channel credential. Anyone who can push to the default branch can already change what the agent does, so this doesn't widen who can act, but it's an exception to "never runs anywhere that holds secrets". Running it in a separate process without the secret would close it.

## Services

| Service | Exposure | Holds | Does |
|---|---|---|---|
| Router | Public, always on | `AGENT_WEBHOOK_KEY`, App private keys, router config | Receives every App's webhooks, filters them, forwards them; mints installation tokens for containers; answers the repo CLI for someone who can push (`/wake`, `/installation`, `/deploy`) |
| Deployer | Private, sleeps when idle; the router wakes it | Container provider token, Claude token | Evaluates repo config, creates and updates containers |
| Container | Private, sleeps when idle | Claude token, its current credentials | Runs agents |

## Webhooks

- Each App's webhook points at the router. There are no repo webhooks; deploys delete old ones.
- Each App's webhook secret is derived from `AGENT_WEBHOOK_KEY` and the App ID. GitHub sends the App ID in `X-GitHub-Hook-Installation-Target-ID`, so the router can check any App's deliveries without a list of Apps.
- For `edited` events, a mention only counts if it wasn't in the text before the edit (`changes.body.from`).

## Router config

- The deployer pushes the router's config to an endpoint signed with `AGENT_WEBHOOK_KEY`. The router keeps it in its container provider's store, so it changes without a redeploy.
- The config says which repos are deployed, and each repo's triggers and workspaces. The router drops everything else, so it doesn't wake containers that would ignore the event. The container checks the triggers again, and skips an event for a workspace its config doesn't have.

## Persisted events

The router writes every event it accepts to its store before answering GitHub, so a crash or restart doesn't lose it. The store is its container provider's: part of the container provider contract, JSON values by name in collections, where a write is durable once it resolves. A name is any string, which each store encodes itself: the router and deployer keep a repo's under its lowercased `owner/name`, and an event under its delivery ID. The router and deployer are told their container provider (`ACHQ_CONTAINER_PROVIDER`) and get their store from it in the registry: on Railway, files on their volume under DATA_DIR; on Cloudflare, their Durable Object's storage. The deployer keeps its records and the deliveries it's handled there too.

- Each accepted delivery is written to `inbox/<delivery-id>.json`, then forwarded. The entry says where it goes: to the deployer, or to the containers it was routed to, each with the workspace and commit it was routed with. It's deleted once its targets answer.
- On startup the router replays everything left in `inbox/`.
- A delivery that runs out of retries moves to `failed/`. If it was for a container, the router replies on its thread, as the channel's source, that it didn't reach the agent and can be replayed, so whoever asked isn't left waiting. A thread is told once per delivery, however often a replay fails.
- `achq infra status` lists failed deliveries, with each target's error. `achq infra replay` puts them back in the inbox, aimed at each container's current URL with the config the router holds now; one whose repo or container is gone is dropped. Nothing replays on its own: a container that's down for good would otherwise be retried forever.
- A crash between forwarding and deleting means a delivery can arrive twice. Containers and the deployer ignore a delivery ID they've already handled.
- This isn't a queue: there's no ordering, priority or backpressure. That stays deferred.

## App keys

- An App is added by declaring its channel in the ACHQ infra. `up` notices it has no credentials and runs GitHub's manifest flow.
- When `achq.config.ts` names a vault (`vault: { provider: "1password", name: "<vault>" }`), the vault is where an App's private key lives, as the item `GitHub App <slug>`. `up` writes a new App's key there first, and a router only ever gets it from there. If the vault can't take it, `up` stops before the router gets it and says how to generate another key.
- A router without the vault's key gets it: `up` puts it on the router, and points the App's webhook at that router, with its secret, instead of running the manifest flow again. A key only the router has is refused, never copied into the vault: a key should be in the vault from the start. A vault key GitHub turns down counts as none.
- Why: an App outlives its router. Keeping its key only on the router meant an App could never move to another router (e.g. `djgrant-claude` from a Railway router to a Cloudflare one), and a second machine couldn't run `up` for it. The infra already runs under `op run`, so the vault is one it's signed in to, and the key passes through your machine only on its way between the vault and the router, never written to disk except as the template `op` reads, readable by you alone and removed at once.
- Without a vault, nothing changes: the key goes straight to the router and never touches the local machine.
- On the router, every App's key is in one variable, `ACHQ_GITHUB_APPS`: JSON, by slug. Each channel adds its own App to it through core's `Router.addToMap`, which declares the variable when the router is planned: what's added over what's stored, so an App whose channel is gone from the infra keeps its key there (removing a channel doesn't delete its App), and two channels with one slug are refused when they're declared.
- The vault is a contract of core's (`VaultProvider`: items by name, each a set of fields), so achq names no vendor; 1Password's, through `op`, is the one built.
- An App moved to another router stops reaching the one it left: it has one webhook.
- Anything else that needs an App key goes through the router's signed endpoint.

## Credentials

How GitHub's credentials work. Other channels and policy providers follow the same pattern where they can.

- Containers never hold App private keys. They ask the router for credentials for their policies.
- The token endpoint listens on a second port the public can't reach, so only achq's own services do: over Railway's private network, or on Cloudflare through Workers that carry the account's internal key.
- A container proves its identity with a secret derived from `AGENT_WEBHOOK_KEY` and its repo and container name. The router only mints credentials for that container's policies.
- Tokens last an hour. A container fetches one when it starts, then refreshes in the background when 30 minutes remain, so a failed refresh retries for half an hour before anything breaks. A stored token with more than 30 minutes left is reused on wake.
- The token is stored on the container's volume at `/data/github/` (mode `600`). Claude can read it, which is acceptable because it's scoped to the container's policies and expires within an hour.
- Accepted risk: the App keys sit on the public router. A bug in its webhook handling would expose them. The router is small and only parses JSON and checks signatures.

## Subscribing

Installing a repo on its code host subscribes it; uninstalling unsubscribes it. On GitHub, that's installing one of the infra's Apps on it, with `achq repo install` or from GitHub's settings.

- **Install:** the deployer evaluates the repo's config and deploys its containers, if the repo's owner is in `owners`.
- **Uninstall:** the repo is removed from the router config, so events stop reaching it. Its containers and volumes are kept, asleep, costing only storage. Reinstalling adds it back and everything is as it was.
- **Deletion** is explicit: `achq infra up --prune` deletes the containers and volumes of repos no longer installed. Railway can't restore a deleted service, and a deleted volume only through an emailed link within 48 hours, so achq never deletes on an event.

- GitHub's `installation` and `installation_repositories` events parse to a `RepoEvent` deploying the repos added and uninstalling the ones removed. The router forwards it to the deployer whether or not the repo is deployed yet, since a repo isn't deployed until its install is handled. The deployer only deploys and uninstalls what it's told.
- Installing on many repos at once arrives as one event listing them all. The deployer handles them one by one, each with its own `ACHQ_STATUS`.

- The deployer handles install and uninstall events as they arrive (`achq repo install` waits on the result), and `achq infra up` syncs too, to catch anything missed.

### Installing from the repo CLI

`achq repo install` runs in a subscriber repo, as you: with your `gh` login, without the infra's vault or any App's key. GitHub only lists installations to a GitHub App's own user token: `GET /user/installations` with `gh`'s token (an OAuth App's) is refused, `403 You must authenticate with an access token authorized to a GitHub App in order to list installations`, and so is `GET /user/installations/{id}/repositories`. Adding a repo to an installation (`PUT /user/installations/{id}/repositories/{repo_id}`) is documented for GitHub App user tokens, installation tokens and fine-grained tokens, and removing one for those and a classic token with `repo`; neither for an OAuth App's token like `gh`'s. `GET /orgs/{org}/installations` takes an OAuth token, but only an org owner's, and nothing like it covers a user's own repos. So nothing `gh` holds can tell whether an App is on a repo, or change it.

- **The router tells.** It holds every App's key. `POST /installation` on its public port, like `/wake`, takes your code host token as the bearer and answers only if it can push to the repo (`canPush`): whether the config's source is installed on the repo (`CodeHostProvider.installation`; on GitHub, the App's installation on the owner, as the App lists them, and a token minted narrowed to the repo), and the page where you'd change that: the App's install page, or its installation's settings. The CLI finds the router in the repo's `ACHQ_STATUS`.
- **You change it on GitHub.** `install` and `uninstall` are straight-line code in the CLI: check the App, ask the router, open the page, wait. `install` opens that page, and then polls `ACHQ_STATUS` for the deploy, as before. GitHub's install page, on an owner that already has the App, goes to its installation, where you add the repo. `uninstall` opens the installation's settings and asks the router until the repo's gone, then deletes `ACHQ_STATUS` with your `gh` login. The CLI reaches the router's public endpoints (`/wake`, `/installation`, `/deploy`) through `routerForPusher` in `@achq/core/client`, as it reaches the signed ones through `routerAdmin`.
- **A repo that's never been deployed** has no `ACHQ_STATUS`, so no router to ask: `install` opens the App's install page, and `uninstall` says where to remove it. So has one uninstalled, or whose infra went down: each deletes it. One whose router is gone without that, e.g. torn down by hand, is the same to `install`.
- Why not the others: asking GitHub with `gh`'s token can't work for user-owned repos at all; and changing an installation through the API needs a token `gh` doesn't have, while GitHub's page works for anyone who could do it. The router only says what `GET /repos/{repo}` would already let a pusher guess.

## Config changes

The App owns the whole lifecycle, including keeping a repo's deployment in line with its config.

- The App subscribes to `push`. A push to the default branch that touches `.achq/` parses to a `RepoEvent` deploying the repo, only if it's deployed already, and any other push to nothing: no trigger acts on a push. The router forwards it to the deployer only for a deployed repo. A push payload's commit list is capped for very large pushes (2048 commits, per GitHub's webhook docs), so a push that hits the cap is forwarded whatever it touches.
- The deployer compares the `.achq/` tree at the new head with the one it last deployed. If it's the same, it stops.
- Otherwise it evaluates the config again and compares the resulting manifest with the deployed one. It redeploys only what changed: a container whose image or policies changed is rebuilt; router config is updated for triggers and workspaces.
- The deployer starts builds itself; the container provider's own deploys on push are off: Railway's auto-deploy, and on Cloudflare the build trigger's path filters, which match nothing. A container is only rebuilt when it's new, or its image path or Dockerfile changed.
- Everything else in the config reaches containers without a rebuild: the router forwards each event with the commit its config came from, and the container loads that commit's `.achq/` from its mirror (cached per commit).
- Containers removed from the config are handled like uninstalls: kept asleep, deleted only by `achq infra up --prune`.
- The outcome goes to `ACHQ_STATUS`.

## Checks

The types can't know which events and permissions an App has enabled, so they're checked against the live App:

| When | Who | Checks against | On failure |
|---|---|---|---|
| `achq repo install --dry-run`, and `install` | CLI, with your `gh` login | `GET /apps/{slug}` | Refuses to install and lists what's missing |
| Deploy | Deployer, through the router | The App's settings, read as the App | Doesn't deploy; writes why to `ACHQ_STATUS` |
| Container start | Container, through the router | The App's settings | Logs triggers the App doesn't send |

- The deploy check is the authoritative one.
- `GET /apps/{slug}` returns 404 for a private App, even to its owner's `gh` login (checked against `djgrant-claude`). For private Apps the CLI check skips the App comparison and only checks the repo's own config.

## Deploy results

Installing is done to a repo, from its settings or with `achq repo install`, not to a commit. So the deployer reports each deploy's outcome on the repo, in a repository variable, `ACHQ_STATUS`:

```json
{ "state": "failed", "at": "2026-10-17T10:02:00Z", "error": "container default wants issue_comment, which notation-achq doesn't send" }
```

- `achq repo install` installs the App, then polls `ACHQ_STATUS` with your `gh` login until it shows a result newer than the install, or times out.
- **What only you can fix.** A container provider can fail a deploy with something only a person can do, in their browser: core's `BrowserActionNeeded`, an error carrying `{ url, what }`. The deployer writes its action into `ACHQ_STATUS` (`action`, beside `error`). `achq repo install`, whatever the provider, opens it, waits for you to press Enter, and has the router deploy the repo again: `POST /deploy`, with your code host token, for someone who can push to it, which puts a `RepoEvent` deploying the repo in the router's inbox for the deployer, as GitHub's install event does. Then it polls `ACHQ_STATUS` again, up to three times. Without a terminal it prints what to open, and re-running `achq repo install` on an installed repo whose last deploy needs you picks it up. Cloudflare's and Railway's throw it when their GitHub App can't see the repo (see On Cloudflare).
- `achq repo status` reads the same variable, so it reports a failed install made from the repo's settings. `achq infra status` reads the deployer's own records for every repo.
- The App needs the "Variables: write" permission (`actions_variables`). Containers don't get it: their tokens only carry their own permissions.

## Commands

| Command | Run from | Does |
|---|---|---|
| `achq infra up [--prune] [--dry-run] [--rotate-deployer-token]` | Infra | Brings the infra's resources in line with its code, and is safe to re-run: router and its config, deployer, each channel's App (creating any that are missing) and its webhook settings, then syncs installed repos |
| `achq infra status` | Infra | Every installed or deployed repo, its state, when it last deployed, and its containers, then any failed deliveries |
| `achq infra replay` | Infra | Sends failed deliveries again, to where their containers are now |
| `achq infra down [--dry-run] [--yes]` | Infra | Shows what it deletes, and asks first, then deletes only what it showed. The deployer syncs to no repos: it uninstalls each, deleting its `ACHQ_STATUS` while the App still reaches it, since the router it names is going, and deletes every container through its `ContainerProvider.remove`. Then each managed resource with a `destroy` is deleted before what it depends on; one without goes with what it is part of, e.g. a Worker's variables with their namespace. A protected resource (`protect: true`) is listed and left, and `down` opens the page where you delete it yourself if it has one (`deletePage`), e.g. the GitHub App (GitHub has no API to delete one) and Cloudflare's deployer token. A data source, e.g. the Cloudflare account, is only ever read |
| `achq repo install [--dry-run]` | Repo | Reads the repo's config, checks it, and installs the repo on its code host: on GitHub, the App its policies name, after checking it sends and allows what the config needs, by opening GitHub where you add the repo (see Installing from the repo CLI). Then waits for the deploy's outcome in `ACHQ_STATUS`, opening what only you can fix if it says so, and deploying again. |
| `achq repo uninstall` | Repo | Opens GitHub where you remove the repo from its App's installation, and waits until the router says it's gone, then deletes its `ACHQ_STATUS` with your `gh` login, as the App can't reach the repo any more; the uninstall flow above follows |
| `achq repo status [--repo]` | Repo | Its `ACHQ_STATUS` |
| `achq container ssh [--repo]` | Repo | As now |
| `achq container resume [n] [session] [--repo]` | Repo | Opens a session: issue `n`'s, or without `n` any thread's. With one session it opens it; otherwise it lists them (ID, thread, agent, last run) as a picker, or prints the list when not interactive. |

These replace `app`, `deploy` and `destroy`. `--repo` takes `owner/name` or a URL, and defaults to the repo `git remote get-url origin` names in the current directory.

## On Cloudflare

`cloudflare.Router` and `cloudflare.Deployer` put the infra on a Cloudflare account, and the deployer puts containers there too. Cloudflare has neither volumes nor a private network, so the plugin makes what the contract needs out of what it has. The contract grew for one thing it couldn't make: a store whose write is durable once it resolves (see Persisted events).

```ts
const router = new cloudflare.Router("router", { project: "achq" });
new cloudflare.Deployer("deployer", { router, owners: ["djgrant"], sshKeys: ["ssh-ed25519 AAAA… me@laptop"] });
```

- **A Worker per service and container.** Each is the same Worker, achq's (`plugin-cloudflare/worker/`), with one Durable Object that runs its container under the `durable_object` scheduling policy. Its `ACHQ_SERVICE` variable says what it is: its port, whether it's public, whether it sleeps, its image. Worker names are the account's, so each is its project's: `achq-router`, `achq-notationlabs-yieldstar-dev`. Containers run on `standard-1`: `lite` is too small for a 2 GB image.
- **The router and deployer** run Cloudflare's own image, `cloudflare/debian-trixie`, so nothing is built for them. Their start command installs Bun under DATA_DIR on the first start, then runs achq at ACHQ_REF, as on Railway. `achq infra up` deploys them with Wrangler from your checkout, as it's signed in, with their variables as secrets.
- **Reaching each other.** A service's `privateUrl(port)` is `http://<port>.<worker>.achq.internal`: Cloudflare only intercepts a container's HTTP on port 80, so the port is in the hostname. The Worker intercepts its container's requests to `*.achq.internal` and sends them to the target Worker's workers.dev URL with the account's internal key (derived from `AGENT_WEBHOOK_KEY`; containers never see it) and the port. A Worker passes a request to its container's port only with the key; without it, only to its public port, which only the router has. Workers fetch each other with `global_fetch_strictly_public`.
- **Persistence.** A container's disk only outlives a stop in a snapshot, and Cloudflare snapshots only when asked, so the Durable Object drives every stop that keeps anything: it snapshots, then stops. It snapshots a long run every 30 minutes too; a crash or a stop Cloudflare makes itself loses what changed since, which is accepted. It restores the latest snapshot on start (about 1.5 seconds).
- **A new image.** A snapshot only restores onto the image it was taken of, and silently boots the old image otherwise. So when a container's Worker has a new image, its next start runs the old snapshot with nothing but a shell, archives `/data` to the project's R2 bucket through `archive.achq.internal`, starts the new image the same way, restores the archive, snapshots that and starts from it. The archive is also made daily, and restored when a snapshot won't start: snapshots expire 30 days after their last restore.
- **The store.** The router writes an event before it answers GitHub; a snapshot per webhook takes 5 seconds or more, and anything after the last snapshot is lost in a crash. Nothing inside the provider can make a file write durable the moment it's made, so the services' assumption that DATA_DIR does became the contract's `store`, which every container provider implements. Cloudflare's is its Durable Object's storage, which keeps a write once it's answered, reached from the container at `http://store.achq.internal`, which the Worker answers, with a value's name in the query so any string is one. The router keeps its inbox, config and claims there, and the deployer its records. Containers stay on DATA_DIR: what they lose in a crash, the router's replay and the next run redo.
- **Variables.** A Worker's secrets can't be read back, and a service's variables (its `env`, the router's generated key, the Apps' keys) have to be. So each Worker's variables are kept as JSON in the project's KV namespace, read and written through the API, which sees its own writes; that's what's set, readable with the token, as Railway's variables are. What runs gets them as Worker secrets: the router's and deployer's with each deploy, a container's set by the deployer. A hash of what was last deployed is kept beside them, so a change redeploys.
- **Sleep.** The Durable Object's alarm looks at its container every minute. The deployer and containers sleep after 10 minutes without a request in flight or a fetch of `ACHQ_KEEP_AWAKE_URL` (`awake.achq.internal`, which their own Worker answers): it snapshots and stops them, and the next request starts them. The router doesn't sleep: its alarm starts it again if it stops. A new Worker version restarts the router and deployer with their new variables; a container picks up its new variables or image when it next starts, as on Railway, where its variables wait for its next deploy.
- **Builds.** All of Workers Builds is the deployer's: `achq infra up` makes no Builds call. Workers Builds builds each container from its repo: a trigger on its Worker, connected to the repo by GitHub's ids, which the deployer's container provider gets from the deployer with the container: the code host reads them alongside the repo's config, with the token the router mints for the deployer, so a private repo's are read too and the Cloudflare plugin never calls GitHub. Builds deploys with an API token registered with it: the deployer registers its own (`POST /builds/tokens` with the token's secret and its id, which `/user/tokens/verify` gives), once, keeping one registered already. If Builds won't register it, the deployer builds with the account's newest token, e.g. one made in the dashboard (connect a repository on a Worker's Build settings and choose "Create new token"), and with none, its error in `ACHQ_STATUS` says where to make one. The trigger's build command fetches achq's Worker at ACHQ_REF and writes the Worker's config, which points `images.app` at the container's Dockerfile, from a variable; its deploy command is `npx -y wrangler@4 deploy`, not exactly `npx wrangler deploy`, which would have Builds open pull requests on the repo. Connecting a repo (`PUT /builds/repos/connections`) is the one place anyone learns whether Cloudflare's GitHub App can see it: when it can't, Cloudflare answers `[8000012] The project is linked to a repository that no longer exists`, a 404, and the deployer fails the deploy with `BrowserActionNeeded` and the App's install page, which `achq repo install` opens. Its path filters match nothing, so pushes don't build; the deployer starts builds and waits for them (1.5 to 3 minutes, with no layer cache), throwing with the end of the log if one fails, or if it deployed no Worker version, which happens when Wrangler pushed the image but the Worker upload failed.
- **Your sign-in.** Locally, the infra commands use Wrangler's OAuth sign-in (`npx wrangler login`): `npx -y wrangler@4 auth token --json` gives a bearer for the REST calls, which lasts an hour and which Wrangler refreshes, so it's asked for again every few minutes, and Wrangler's deploys use the sign-in themselves. `CLOUDFLARE_API_TOKEN`, if set (e.g. in CI), is used instead. `CLOUDFLARE_ACCOUNT_ID` is optional: without it, the account is the only one the sign-in reaches, and with several, the check lists them. The check before the commands is that you're signed in, or a token is set, and it can read the account (`GET /accounts/{id}`); `/user/tokens/verify` only takes API tokens, not an OAuth sign-in's. The sign-in reaches the account, KV, R2, containers and Workers deploys with secrets, but not Workers Builds (`[10000] Authentication error`), and no sign-in can make API tokens (`[9109]`).
- **The deployer's token.** So the deployer has an API token of its own, which you make once. When its Worker has no `ACHQ_CLOUDFLARE_DEPLOYER_TOKEN` secret (secret names can be listed, not read), `achq infra up` opens the dashboard's create-token page with its permissions, the account and its name filled in (Workers Scripts, KV, R2, Containers, Cloudchamber and Workers Builds to edit, the account's settings to read), asks you to paste what it makes, without echoing it, checks it (`/user/tokens/verify`, then that it can read the account), and sets it as the deployer Worker's secret alone: never on disk, in the namespace or in the variables, so nothing can read it back. The Worker passes it to the deployer's container, not to the environment written for its shells, and a new one restarts the deployer. `--rotate-deployer-token` makes a new one. The deployer gets no copy of your credentials: its variables say only where things are.
- **Browser flows.** What only you can do, `achq infra up` opens your browser to, then waits for, as it does to create an App: making the deployer's token. Cloudflare's GitHub App ("Cloudflare Workers and Pages", which Builds clones with) can't be checked from your machine: your `gh` login can't list installations, and only Cloudflare knows which repos its App sees. So `up` says nothing of it, and a repo it can't see fails its deploy with the App's install page, which `achq repo install` opens (see Builds, and Deploy results).
- **Shell.** `achq container ssh` and `resume` use `wrangler containers ssh` on the container's running instance, as you're signed in to Wrangler, with one of the deployer's `sshKeys`: public key lines the deployer writes into each container Worker's `authorized_keys`, which Wrangler's SSH connects with. Railway needs none: `railway ssh` connects as you're signed in. A shell there doesn't get the container's environment, so the Durable Object writes it to `/run/achq/env` when it starts the container, and the command runs with it.

## Not yet verified

Every part has run together in one process (`packages/test-e2e/test/e2e.test.ts`) against a fake GitHub, a fake container provider and a fake `claude`. Not yet run for real:

- Railway: turning off auto-deploy with `serviceInstanceAutoDeployUpdate`, the router and deployer start command, sleeping and waking over the private network.
- GitHub: the manifest flow and `PATCH /app/hook/config` on a new App, minting with `actions_variables`. Installing no longer calls GitHub with `gh`'s token beyond reading the App and `ACHQ_STATUS`; GitHub's install page going to an owner's existing installation, where you add the repo, is from using it by hand.
- The container image: `install.sh`, the `perl`-based lock, Claude Code's `--effort` and `CLAUDE_CONFIG_DIR`.
- Cloudflare, all of it beyond the API calls the spikes made: the achq Worker in Cloudflare's runtime (its intercepts, `ctx.exports`, its alarm, snapshot restore failing as a stopped container), Wrangler deploying a `durable_object` container with no images for `cloudflare/debian-trixie`, Bun from npm in that image, one Worker fetching another's workers.dev URL, Worker secrets surviving a Builds deploy over a placeholder, the build command's archive path, the GitHub page the browser flow opens, that Workers Builds refuses to connect any repo its GitHub App can't see with `[8000012]` (seen once, for real), and `wrangler containers instances --json`. Of its sign-in and tokens: registering the deployer's token with Builds (`POST /builds/tokens`), and so the dashboard fallback; the deployer's token secret surviving Wrangler's deploys; the deployer's pasted token reaching everything it needs with the permission keys the create-token page is filled in with (the page itself was checked by hand); and `wrangler auth token --json`'s output, read from Wrangler 4.152's source rather than run.
- 1Password: `op item get --format json --reveal`, `op item create --template`, `op item delete --archive` and the "isn't an item" message, as achq calls them; only a fake `op` has run.

## Deferred

- A real queue between the router and containers: ordering, backpressure. The router's persisted events cover crashes and restarts.
- Hosting the router, deployer and containers on different container providers.
- Channels and policy providers other than GitHub.

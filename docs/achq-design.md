# ACHQ design

Decisions for moving achq from one App with per-repo webhooks to a system that runs one router and many Apps. Not built yet.

## Layers

- **ACHQ tool**: The CLI, the router, the deployer, the agent, and the resource library. Nothing user-specific. npm-ready (correct `bin` and `exports`) but not published; `bin/achq` stays for putting on `PATH`.
- **ACHQ infra**: Declares the router, deployer and Apps as resources. Reads secrets from its environment; how they get there (`op run`, direnv, CI, a `.env` file) is up to the user.
- **ACHQ repos**: `.achq/config.ts` and an image. Defines the conditions an agent works in, and the events on which it is dispatched.

## Resources

Both the infra and repos are written as a resource graph, Pulumi-shaped: resources take other resources as inputs, and those inputs are the bindings. achq has its own small resource model: each resource can `diff` against what exists and `apply`. A dry run stops after the diff.

### The infra

```ts
export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  const deployer = new railway.Deployer("deployer", {
    project: "achq",
    router,
    containers: railway.containers({ project: "achq" }),
    owners: ["djgrant", "notationlabs"],
  });
  new github.App("personal", { name: "djgrant-claude", router, deployer });
  new github.App("notation", { name: "notation-achq", org: "notationlabs", router, deployer });
});
```

- **Router**: receives events and wakes the deployer and containers.
- **Deployer**: creates and updates containers. Containers are a property of the deployer: it's configured with the host it deploys them to.
- **Sources** (a GitHub App) bind to both. The App's webhook points at the router, and the router holds the App's key to check deliveries and mint tokens. The App's installations decide which repos the deployer serves.
- Each component could in principle be hosted on a different platform. That needs bindings the current design assumes away: reaching containers without a private network, and waking them through the container host's API. Only Railway is built for now.
- **`owners`**: the deployer only serves repos owned by these accounts. A public App can be installed by anyone, and without this a stranger's install would get a container on your Railway account running on your Claude token.

### A repo

```ts
// .achq/config.ts
import { container, claude, github } from "achq";

const notation = github.App.get("notation-achq");

export default [
  container({
    source: notation,
    image: "./Dockerfile",
    permissions: { contents: "write", issues: "write", pull_requests: "write" },
    agents: [
      claude({ on: [notation.issueComment({ actions: ["created", "edited"], mention: "@claude" })] }),
      claude({ on: [notation.issue({ actions: ["opened"] })], model: "claude-haiku-5-5", prompt: "triage.md" }),
    ],
  }),
];
```

- A repo **adopts** an App by slug with `github.App.get`. It's typed as a GitHub App, so every GitHub event and permission is typed, but not which ones this App has enabled. That's checked at runtime against the live App (see Checks).
- A repo can define several **containers**. A container is an image, permissions (its token's scope) and a volume.
- A container runs several **agents**. Each agent has its own triggers and settings. Agents in one container share its worktrees and token. Anything needing different permissions goes in a different container.
- The trigger (`mention`) belongs to the repo, not the ACHQ infra.
- Triggers must be plain data, because the router filters on them without waking anything. Agent settings can be code.

## Running repo config

Repo config is code. It never runs anywhere that holds secrets.

1. The deployer downloads `.achq/` from the default branch, with a repo-scoped token from the router.
2. It bundles the config into one file with `Bun.build`, with macros off. Bundling doesn't run the config's code.
3. It runs the bundle in QuickJS compiled to WebAssembly, which has no filesystem, network or environment access. A Bun subprocess isn't enough: it runs as the same user and could read the deployer's secrets from `/proc/<pid>/environ`.
4. The config returns a plain-data plan: containers, images, permissions, agents' triggers. The deployer creates the containers and pushes the triggers to the router. Each container runs its own config again at runtime for the agent settings, which can be code.

Config can only import `achq` and its own files under `.achq/`.

## Services

| Service | Exposure | Holds | Does |
|---|---|---|---|
| Router | Public, always on | `AGENT_WEBHOOK_KEY`, App private keys, router config | Receives every App's webhooks, filters them, forwards them; mints installation tokens for containers |
| Deployer | Private, sleeps when idle; the router wakes it | Railway token, Claude token | Evaluates repo config, creates and updates containers |
| Container | Private, sleeps when idle | Claude token, its current installation token | Runs agents |

## Webhooks

- Each App's webhook points at the router. There are no repo webhooks; deploys delete old ones.
- Each App's webhook secret is derived from `AGENT_WEBHOOK_KEY` and the App ID. GitHub sends the App ID in `X-GitHub-Hook-Installation-Target-ID`, so the router can check any App's deliveries without a list of Apps.
- A container only accepts events from its own source, so a repo with two Apps installed doesn't run twice.
- For `edited` events, a mention only counts if it wasn't in the text before the edit (`changes.body.from`).

## Router config

- The deployer pushes the router's config to an endpoint signed with `AGENT_WEBHOOK_KEY`. The router stores it on a small volume, so it changes without a redeploy.
- The config says which repos are deployed and each container's triggers. The router drops everything else, so it doesn't wake containers that would ignore the event. The container checks again.
- A router redeploy loses forwards in flight. GitHub doesn't redeliver automatically; redeliver by hand or comment again. A queue would fix this later.

## App keys

- An App is added by declaring it in the ACHQ infra. `up` notices it has no credentials and runs GitHub's manifest flow.
- `up` writes the App's private key straight to the router's Railway variables. It never touches the local machine. The ACHQ infra's local environment only needs the Railway token and the Claude token.
- Anything else that needs an App key goes through the router's signed endpoint.

## Installation tokens

- Containers never hold App private keys. They ask the router for an installation token.
- The token endpoint listens on a second port with no public domain, so only the private network reaches it.
- A container proves its identity with a secret derived from `AGENT_WEBHOOK_KEY` and its repo and container name. The router only mints a token for that repo, with that container's permissions.
- Tokens last an hour. A container fetches one when it starts, then refreshes in the background when 30 minutes remain, so a failed refresh retries for half an hour before anything breaks. A stored token with more than 30 minutes left is reused on wake.
- The token is stored on the container's volume at `/data/github/` (mode `600`). Claude can read it, which is acceptable because it's scoped to one repo and expires within an hour.
- Accepted risk: the App keys sit on the public router. A bug in its webhook handling would expose them. The router is small and only parses JSON and checks signatures.

## Subscribing

Installing an App on a repo subscribes it; uninstalling unsubscribes it.

- **Install:** the deployer evaluates the repo's config and deploys its containers, if the repo's owner is in `owners` and the config's `source` is the App that was installed.
- **Uninstall:** the repo is removed from the router config, so events stop reaching it. Its containers and volumes are kept, asleep, costing only storage. Reinstalling adds it back and everything is as it was.
- **Deletion** is explicit: `achq up --prune` deletes the containers and volumes of repos no longer installed. Railway can't restore a deleted service, and a deleted volume only through an emailed link within 48 hours, so achq never deletes on an event.

Phasing:

1. First: `achq up` handles installs and uninstalls when it syncs.
2. Later: the router forwards `installation` and `installation_repositories` events to the deployer, which handles them as they happen.

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
- The App needs the "Variables: write" permission. Containers don't get it: their tokens only carry their own permissions.

## Commands

| Command | Run from | Does |
|---|---|---|
| `achq up [--prune] [--dry-run]` | Infra | Brings the infra's resources in line with its code, and is safe to re-run: router and its config, deployer, each App (creating any that are missing) and its webhook settings, then syncs installed repos |
| `achq status` | Infra or repo | From the infra: Apps, their installations, and each repo's containers and last deploy. From a repo: its `ACHQ_STATUS` |
| `achq install [--dry-run]` | Repo | Reads the repo's config, checks it, and installs its `source` App on the repo, then waits for the deploy's outcome in `ACHQ_STATUS`. Opens GitHub's install page if the App has no installation on the account yet. |
| `achq uninstall` | Repo | Removes the repo from its App's installation; the uninstall flow above follows |
| `achq ssh`, `achq resume <n>` | Repo | As now |

These replace `app`, `deploy` and `destroy`.

## Still to decide

- Whether agents in one container share an issue's session or each have their own.
- What else an agent's settings control: Claude settings, prompts, branch strategy (item 1). Repo config is read from the default branch, never from the issue's worktree.

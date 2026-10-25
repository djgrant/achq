# CLI Reference

| Command group | Run from | Manages |
| --- | --- | --- |
| `achq infra *` | ACHQ repo (`achq.infra.ts`) | Central `Router`, `Deployer`, and `Channel` resources |
| `achq repo *` | Subscriber repo (`.achq/config.ts`) | Repo subscription and outpost build status |
| `achq container *` | Subscriber repo (or `--repo <owner/name>`) | Interactive agent sessions (`resume`) and shells (`ssh`) |

## `achq infra`

### `achq infra up`

Deploy infrastructure changes and reconcile subscribed outposts:

```sh
achq infra up [--dry-run] [--prune] [--rotate-deployer-token]
```

Plans and applies `achq.infra.ts`, then syncs all subscribed repositories.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Prints planned infra and outpost diffs without modifying resources |
| `--prune` | Deletes sleeping outpost containers and `/data` disks for unsubscribed repos or removed containers |
| `--rotate-deployer-token` | Prompts for a replacement Cloudflare API token and updates `cloudflare.Deployer` |

### `achq infra status`

Inspect the health of subscribed outposts and webhook queues:

```sh
achq infra status
```

Lists every subscribed repository (deploy state, timestamp, containers) and any webhook deliveries in the `failed` queue.

### `achq infra replay`

Retry webhook deliveries that failed while an outpost was unreachable:

```sh
achq infra replay
```

Re-queues failed webhook deliveries against each outpost container's current URL and configuration.

### `achq infra down`

Tear down all outposts and control plane resources:

```sh
achq infra down [--dry-run] [--yes]
```

Tears down all outpost containers (`ACHQ_STATUS` cleared), then destroys `Deployer`, `Router`, and cloud project resources in reverse dependency order. Opens browser settings for protected resources (GitHub Apps, user API tokens).

| Flag | Effect |
| --- | --- |
| `--dry-run` | Prints resources that would be deleted |
| `--yes` | Skips confirmation prompt |

## `achq repo`

### `achq repo install`

Subscribe the current repository to your control plane:

```sh
achq repo install [--dry-run]
```

Connects the repository to the channels in `.achq/config.ts` and waits for the initial container build:

```text
1. Validate .achq/config.ts permissions against referenced channels
2. Open browser to install the channel App on the repo (if needed)
3. Poll ACHQ_STATUS until outpost containers finish building
4. Open builder authorization URL (if needed) and re-trigger deploy
```

### `achq repo uninstall`

Unsubscribe the current repository from your control plane:

```sh
achq repo uninstall [--dry-run]
```

Opens the channel's installation settings in your browser, waits for removal, and deletes `ACHQ_STATUS`. Outpost containers stay asleep until `achq infra up --prune`.

### `achq repo status`

Check the deployment state of a repository's outpost:

```sh
achq repo status [--repo acme/webapp]
```

Prints the repository's `ACHQ_STATUS` variable (defaults to local `origin` remote).

## `achq container`

### `achq container ssh`

Open an interactive shell or run a one-off command inside an outpost container:

```sh
achq container ssh [--repo <owner/name>] [--container <name>] [-- <cmd...>]
```

Connect to the default container or pass a command to a specific outpost:

```sh
achq container ssh
achq container ssh --repo acme/webapp --container dev -- ls -la /data/worktrees
```

Wakes the outpost container via the `Router` and opens an SSH shell (or runs `<cmd...>`). Requires push access to the repository.

### `achq container resume`

Attach your local terminal to an agent session on a remote worktree:

```sh
achq container resume [thread] [session] [--repo <owner/name>] [--container <name>]
```

Pick a session interactively or target a specific issue and agent:

```sh
achq container resume              # pick from all sessions in the container
achq container resume 42           # attach to thread #42's session
achq container resume 42 coder     # attach to `coder` on thread #42
```

Wakes the outpost container and attaches the agent's interactive TUI inside the thread's `/data` worktree.

| Argument / Flag | Effect |
| --- | --- |
| `thread` | Thread number (`42`) to filter sessions |
| `session` | Session UUID or agent name (`coder`) |
| `--repo <owner/name>` | Target repository (defaults to `origin` remote) |
| `--container <name>` | Container name when `.achq/config.ts` declares multiple containers |

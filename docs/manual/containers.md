# Containers & Policies

| Ephemeral CI runner | Outpost `Container` |
| --- | --- |
| Fresh VM per run; disk discarded on exit | Sleeps when idle; `/data` disk persists across runs |
| Long-lived secrets in environment variables | Short-lived tokens minted on demand by `Router` |

Provision a persistent machine for your repository's agents:

```ts [.achq/config.ts]
const dev = new Container("dev", {
  image: "./Dockerfile",
  policies: [code, shared], // <-- credentials the container is allowed to mint
  files: {
    "~/.npmrc": "./npmrc",  // <-- copies .achq/npmrc to /data/home/.npmrc
  },
});
```

`Container` declares an outpost machine: its Docker image, the `Policy` objects it can request tokens for, and startup files written into `/data/home`.

## Dockerfile

Install your project's toolchain alongside the ACHQ runner:

```dockerfile [.achq/Dockerfile]
FROM node:22.18-bookworm
RUN npm install -g bun@1.4.3

# Repo-specific packages and toolchains
RUN apt-get update && apt-get install -y jq postgresql-client && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://raw.githubusercontent.com/djgrant/achq/main/install.sh | sh
```

| Requirement | Reason |
| --- | --- |
| **Debian/Ubuntu base** | `install.sh` uses `apt-get` to install `git`, `gh`, `curl`, and process tools |
| **Global `bun`** | `/usr/local/bin/achq-runner` runs `@achq/runner` with `bunx`, at the version the deployer gives the container, and installs the infrastructure's plugins under `/data/plugins` |
| **System-wide paths** | Runner drops privileges to user `agent` (`HOME=/data/home`) |
| **No `CMD` / `ENTRYPOINT`** | Container provider starts `/usr/local/bin/achq-runner` directly |

## Policies

Grant the container scoped access to the repositories it needs:

```ts [.achq/config.ts]
const code = new github.Policy("code", {
  channel,
  permissions: { contents: "write", issues: "write", pull_requests: "write" }, // <-- current repo (acme/webapp)
});

const shared = new github.Policy("shared", {
  channel,
  repo: "acme/shared", // <-- cross-repo read access
  permissions: { contents: "read" },
});
```

Outpost containers never hold channel private keys or cloud API tokens. They request short-lived tokens from the `Router` before each run:

```text
Container ("dev" in acme/webapp)
  │
  │  1. requests tokens over private network
  ▼
ACHQ Router
  │  2. verifies policies deployed for acme/webapp "dev"
  │  3. mints 1-hour tokens scoped to [code, shared]
  ▼
Container writes tokens to /data/github/ and refreshes them during long runs
```

| Stage | Verification |
| --- | --- |
| **Deploy time** | Deployer verifies the channel is installed on every target repo, matches allowed `owners`, and grants the requested permissions |
| **Run time** | Runner configures `git` credential helpers inside the container to pick the matching token per repository URL |

## Volume layout

State persists across runs and image rebuilds on the `/data` volume:

```text
/data/
├── home/                           # $HOME for the unprivileged `agent` user
├── mirror.git/                     # bare git mirror (worktrees branch locally in ms)
├── worktrees/<workspace>/<thread>/ # git checkout per active thread
├── agents/<agent>/                 # isolated config and transcripts per Agent
├── threads/<thread>.json           # workspace claim and session IDs per thread
└── github/                         # short-lived installation tokens
```

`achq container ssh` opens a shell inside `/data`.

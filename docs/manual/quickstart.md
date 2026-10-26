# Quick Start

Deploy an ACHQ control plane on Cloudflare, subscribe `acme/webapp`, trigger Claude Code from a GitHub issue, and resume the session in your terminal. Install the CLI first (see [Installation](./installation.md)).

## 1. Deploy ACHQ (`achq.infra.ts`)

In your infra repository, add the packages `achq.infra.ts` imports:

```sh
pnpm add -D @achq/core @achq/cloudflare @achq/github @achq/claude
```

Declare the control plane for the `acme` organization:

```ts [achq.infra.ts]
import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as cloudflare from "@achq/cloudflare/infra";
import * as github from "@achq/github/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "acme-agents" });

  new cloudflare.Deployer("deployer", {
    router,
    owners: ["acme"],
    sshKeys: ["ssh-ed25519 AAAA... me@laptop"], // <-- ~/.ssh/id_ed25519.pub for `achq container resume`
  });

  new github.CodeHost("github");
  new github.Channel("github", { name: "acme-agents", org: "acme", router });
  new claude.AgentRuntime("claude");
});
```

Authenticate with Cloudflare and Claude, then bring the control plane up:

```sh
npx wrangler login
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
achq infra up
```

`achq infra up` deploys the control plane and opens your browser twice:

| Browser prompt | Creates |
| --- | --- |
| **1. Cloudflare API token** | Scoped token for `cloudflare.Deployer` to build outpost containers |
| **2. GitHub App** | `acme-agents` App wired to `<router.url>/webhook` |

## 2. Declare an outpost (`.achq/`)

In `acme/webapp`, add the packages `.achq/config.ts` imports:

```sh
pnpm add -D @achq/core @achq/github @achq/claude
```

Define the container image where agents will run:

```dockerfile [.achq/Dockerfile]
FROM node:22.18-bookworm
RUN npm install -g bun@1.4.3
RUN curl -fsSL https://raw.githubusercontent.com/djgrant/achq/main/install.sh | sh
```

Wire GitHub issues and `@claude` mentions to that container:

```ts [.achq/config.ts]
import { Container, Trigger, Workspace } from "@achq/core";
import * as claude from "@achq/claude";
import * as github from "@achq/github";

const channel = github.Channel.get("acme-agents");
const code = new github.Policy("code", {
  channel,
  permissions: { contents: "write", issues: "write", pull_requests: "write" },
});
const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });

new Workspace("issues", {
  container: dev,
  threads: channel.issues,
  branch: "issue-{number}", // <-- issue #42 -> branch `issue-42`
  base: "main",
});

const coder = new claude.Agent("coder", { model: "claude-opus-5-5", effort: "high" });
new Trigger("mention", {
  event: channel.issueComment({ actions: ["created", "edited"], mention: "@claude" }),
  agent: coder,
});
```

Push `.achq/` to `main` so the remote deployer can read it:

```sh
git add .achq && git commit -m "Add achq config" && git push
```

## 3. Subscribe the repository

Connect `acme/webapp` to your control plane and build its container:

```sh
achq repo install
```

`achq repo install` walks through installation and waits for the initial build:

```text
1. Opens GitHub in browser ──► Install `acme-agents` on `acme/webapp`
2. Webhook wakes Deployer  ──► Builds `dev` image from `.achq/Dockerfile`
3. Deploy completes        ──► `ACHQ_STATUS` reports `dev` ready
```

## 4. Trigger from a GitHub issue

Open issue `#42` on `acme/webapp` and mention `@claude`:

```text [GitHub issue #42 comment]
@claude explain how the request handler validates sessions
```

The comment dispatches `coder` into issue `#42`'s branch:

```text
Issue #42 comment ──► Router claims #42 for Workspace "issues"
                  ──► Wakes Container "dev"
                  ──► Checks out branch `issue-42` in `/data/worktrees/issues/acme-webapp-42`
                  ──► Runs Agent "coder" and posts reply to #42
```

## 5. Resume in your terminal

Take over issue `#42`'s session locally:

```sh
achq container resume 42
```

Wakes `dev` and attaches your terminal directly to `coder`'s interactive TUI inside `/data/worktrees/issues/acme-webapp-42`.

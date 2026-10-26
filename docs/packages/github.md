# `@achq/github`

`@achq/github` connects GitHub repositories and issues to ACHQ across two entrypoints:

```sh
bun add -D @achq/github
```

| Import path | Used in | Exports |
| --- | --- | --- |
| `@achq/github/infra` | `achq.infra.ts` | `github.Channel` (provisions the GitHub App and webhook) |
| `@achq/github` | `.achq/config.ts` | `Channel.get`, `Policy`, `channel.issues`, `channel.issueComment`, `channel.issue` |

## Channel

Register a GitHub App and wire its webhooks to your router:

```ts [achq.infra.ts]
import { achq } from "@achq/core";
import * as cloudflare from "@achq/cloudflare/infra";
import * as github from "@achq/github/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "acme-agents" });

  new github.Channel("github", {
    name: "acme-agents", // <-- GitHub App name; slugified as the channel id
    org: "acme",         // <-- omit for a personal GitHub account
    router,
  });
});
```

| GitHub App manifest | Value |
| --- | --- |
| **Webhook URL** | `<router.url>/webhook` |
| **Events** | `issues`, `issue_comment`, `push` |
| **Permissions** | `contents: "write"`, `issues: "write"`, `pull_requests: "write"`, `actions_variables: "write"`, `metadata: "read"` |

## Selectors

Match the issue threads that belong in a workspace:

```ts [.achq/config.ts]
const channel = github.Channel.get("acme-agents");

new Workspace("docs", {
  container: dev,
  threads: channel.issues.where({ labels: ["docs"] }), // <-- omit .where(...) to match all issues
  branch: "issue-{number}",
  base: "main",
});
```

Filter the issue or comment events that wake an agent:

```ts [.achq/config.ts]
new Trigger("mention", {
  event: channel.issueComment({
    actions: ["created", "edited"], // <-- default: ["created"]
    mention: "@claude",
    labels: ["docs"],
  }),
  agent: coder,
});
```

| Selector | Options | Matches |
| --- | --- | --- |
| `channel.issues` | `.where({ labels?: string[] })` | Issue threads carrying all listed labels |
| `channel.issueComment(opts?)` | `actions`, `mention`, `labels` | Comment `"created"` / `"edited"` events |
| `channel.issue(opts?)` | `actions`, `mention`, `labels` | Issue `"opened"` / `"edited"` / `"reopened"` / `"labeled"` events |

## Policy

Grant an outpost container scoped installation tokens for a repository:

```ts [.achq/config.ts]
import * as github from "@achq/github";

const code = new github.Policy("code", {
  channel,
  repo: "acme/webapp", // <-- omit to scope to the current repository
  permissions: {
    contents: "write",
    pull_requests: "write",
  },
});
```

Mints a 1-hour GitHub installation token scoped to `repo` and `permissions` before each agent run.

# github-agent

Mention `@claude` on a GitHub issue and Claude Code works on it in a container on Railway: it answers questions, edits the issue, and pushes branches and PRs. Each repo gets its own Railway service, built from the repo's own Dockerfile, with a volume that keeps every issue's session and worktree.

## Using it

Comment on an issue:

| Comment | Does |
|---|---|
| `@claude <prompt>` | Resume the issue's session, or start one |
| `@claude /new <prompt>` | Start a fresh session |
| `@claude /compact [focus]` | Compact the session |

Claude writes to the issue itself with `gh`. The runner appends a footer to Claude's last comment of each run: context used, turns, and the session ID. It posts its own comment only when a run fails, compacts, or ends without Claude commenting.

One run per issue at a time. Comments made during a run queue up, and the next run picks up all of them.

## The repo contract

A repo opts in with one file, `.agentkit/Dockerfile`. It installs the repo's toolchain, installs the agent, and runs it:

```dockerfile
FROM node:22.18-bookworm
RUN npm install -g bun@1.3.14 pnpm@11.17.0
RUN curl -fsSL https://raw.githubusercontent.com/djgrant/agentkit/<ref>/github-agent/install.sh | sh -s <ref>
CMD ["github-agent"]
```

- **Base image:** Debian-based, because the install script uses apt. The image needs `bun` on `PATH`.
- **System-wide tools:** the agent runs as the unprivileged `agent` user, so install tools system-wide, not under `/root`.
- **Instructions:** Claude follows the repo's `AGENTS.md` or `CLAUDE.md`, including how to set up a fresh worktree.

Railway only redeploys when `.agentkit/**` changes. A redeploy stops running sessions; the agent reports them on the issues when it comes back.

## The GitHub contract

- **Trigger:** a new comment on an issue (not a PR) that mentions `@claude`. Both the commenter and the issue author must be an owner, member or collaborator.
- **What Claude sees:** the runner renders `prompts/new.md` or `prompts/resume.md` with the issue body and comments by those users only, and says how many others it left out. Claude can't read issues itself (`gh issue view`, `gh issue list`, `gh api` and `gh search` are denied), so text from anyone else never reaches it.
- **Identity:** Claude acts as the GitHub App, with contents, issues and pull requests set to read/write. PRs opened by the App trigger CI.
- **Branches:** each issue starts on `issue-<n>`. Claude may switch to a more descriptive branch.

## The container

```
/data/home/                 HOME: ~/.claude holds every session's transcript
/data/repo.git              bare mirror
/data/worktrees/issue-<n>   one worktree per issue, left as Claude leaves it
/data/issues/<n>.json       session ID, last comment handled, status
/data/locks/issue-<n>       flock held during a run
/data/github/               the App's installation token, refreshed every few minutes
```

To get in yourself (needs the Railway CLI):

```sh
ak agent resume <owner/repo> <n>   # the issue's current session, interactively, in its worktree
ak agent ssh <owner/repo>          # a shell in the container
```

`resume` opens the issue's current session: the one the footers name, which `/new` replaces. It fails if a run is in progress. While you're in, the agent's next run for the issue waits until you exit. Inside the container it's `github-agent resume <n>`.

## Setting it up

`ak agent` commands, with credentials in `github-agent/secrets.env`, which is gitignored:

1. `ak agent app [--org <org>]` creates the GitHub App through GitHub's manifest flow and saves its ID, slug and private key. Install the App on each repo afterwards.
2. Add `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and `RAILWAY_API_TOKEN` (an account token) to `secrets.env`. A value can be a 1Password reference, `op://vault/item/field`. If you have more than one Railway workspace, also set `RAILWAY_WORKSPACE_ID`.
3. `ak agent add <owner/repo>` does the rest, and is safe to re-run:
   - creates the `agentkit` Railway project if it doesn't exist
   - creates the repo's service with a volume and a domain, sets its variables, and connects it to the repo
   - creates the repo's webhook
4. `ak agent status` lists the deployed agents. `ak agent remove <owner/repo>` deletes a repo's service, volume and webhook.

# github-agent

Mention `@claude` on a GitHub issue and Claude Code works on it in a container on Railway: it answers questions, edits the issue, and pushes branches and PRs. Each repo gets its own Railway service, built from the repo's own Dockerfile, with a volume that keeps every issue's session and worktree.

Repo services sleep when idle and have no public domain. One always-on router, `agentkit-router`, receives every repo's webhook, ignores comments that don't mention `@claude`, and forwards the rest to the repo's service over Railway's private network, retrying for about five minutes while the service wakes. A service stays awake while a run is in progress and sleeps 5–10 minutes after it ends.

## Using it

Comment on an issue:

| Comment | Does |
|---|---|
| `@claude <prompt>` | Resume the issue's session, or start one |
| `@claude /new <prompt>` | Start a fresh session |
| `@claude /compact [focus]` | Compact the session |

The runner posts Claude's final reply as an issue comment. When a run fails or compacts, it posts that instead. Claude can't comment itself (`gh issue comment` is denied), but it can edit the issue body and open PRs.

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

Railway only redeploys when `.agentkit/**` changes. To update the agent itself, push agentkit and re-run `ak agent deploy`: it sets the service's `AGENTKIT_REF` build arg to the latest agentkit commit that changed `github-agent/`, and redeploys if that or anything else it manages changed. A redeploy stops running sessions; the agent reports them on the issues when it comes back.

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

Both wake a sleeping service first, through the router, and `resume` keeps it awake while you're in. `resume` opens the issue's current session. It fails if a run is in progress. While you're in, the agent's next run for the issue waits until you exit. Inside the container it's `github-agent resume <n>`.

## Setting it up

`ak agent` commands, with credentials in `github-agent/secrets.env`, which is gitignored:

1. `ak agent app [--org <org>]` creates the GitHub App through GitHub's manifest flow and saves its ID, slug and private key. Install the App on each repo afterwards.
2. Add `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and `RAILWAY_API_TOKEN` (an account or workspace token) to `secrets.env`. A value can be a 1Password reference, `op://vault/item/field`. If you have more than one Railway workspace, also set `RAILWAY_WORKSPACE_ID`.
3. `ak agent deploy <owner/repo>` does the rest. Re-running it only changes what differs:
   - creates the `agentkit` Railway project if it doesn't exist
   - creates the repo's service with a volume, sets its variables, and connects it to the repo, or updates them and redeploys if they changed
   - creates the router, or redeploys it if `router.ts` changed. It runs `src/router.ts` on the stock Bun image, so it needs no build
   - creates the repo's webhook, pointing at the router
4. `ak agent status` lists the deployed agents. `ak agent destroy <owner/repo>` deletes a repo's service, volume and webhook.

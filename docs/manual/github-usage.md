# Threads & Sessions

Every thread on `/data` can be driven from two interfaces interchangeably:

| Interface | Entrypoint | Runs in |
| --- | --- | --- |
| **Channel thread** | `@claude` comment on GitHub issue `#42` | `/data/worktrees/issues/acme-webapp-42` (`issue-42`) |
| **Terminal session** | `achq container resume 42` | Same worktree and agent transcript over SSH |

## Channel threads

Slash commands immediately after an `@mention` control the thread's session:

| Comment on issue `#42` | Session action |
| --- | --- |
| `@claude fix the failing test` | Resumes existing session (or starts one on first turn) |
| `@claude /new try a different approach` | Starts a fresh session in the existing `issue-42` worktree |
| `@claude /compact keep test failure details` | Compacts the session context window before continuing |

## Terminal sessions

Drop into a remote worktree or take over an agent session from your terminal:

```sh
achq container resume              # pick interactively from all sessions
achq container resume 42           # attach to issue #42's session
achq container resume 42 coder     # select the `coder` agent on issue #42
achq container ssh                 # open a plain shell in `/data`
```

## Access control

ACHQ enforces two boundaries on public repositories:

| Boundary | Enforcement |
| --- | --- |
| **Trigger filter** | Router only accepts triggers from collaborators with `write` access on issues opened by collaborators with `write` access |
| **Prompt assembly** | Runner strips untrusted comments from the prompt and disables built-in issue-fetching tools |

> [!IMPORTANT]
> A `github.Policy` with `issues: "write"` or `pull_requests: "write"` gives `gh` inside the container a token that can read raw comments via `gh issue view`. Grant only the permissions each container requires.

## Failure recovery

Worktree and session state on `/data` survive errors and restarts:

| Failure | Reported on thread | Recovery |
| --- | --- | --- |
| **Agent exits with error** | `⚠️ The run failed.` + last 40 lines of `stderr` | Comment `@claude <prompt>` to retry, or `@claude /new <prompt>` |
| **Container restarts mid-run** | Interrupted-run notice + session ID on boot | Comment `@claude <prompt>` or run `achq container resume 42` |
| **Container unreachable** | Delivery moved to `failed` queue + thread notice | Run `achq infra status`, then `achq infra replay` |

// What the runner says on threads, and to whoever runs `resume`. Kept apart
// from the code that decides to say it.

const WARNING = "⚠️";
const SHORT_COMMIT = 7;

export const failureReply = (message: string) => `${WARNING} ${message}`;

export const unrunnableAgent = (trigger: { name: string; agent: string }) =>
  failureReply(`Trigger \`${trigger.name}\` names agent \`${trigger.agent}\`, which this container can't run.`);

export const NOTHING_TO_COMPACT = "There is no current session on this thread to compact.";

export const resumeHint = (mention: string | undefined) =>
  mention ? `\n\nComment \`${mention} <prompt>\` to resume the session, or \`${mention} /new <prompt>\` to start over.` : "";

export const runFailed = (error: string, mention: string | undefined) =>
  `${WARNING} **The run failed.**\n\n<details><summary>Error output</summary>\n\n\`\`\`\n${error}\n\`\`\`\n\n</details>${resumeHint(mention)}`;

export const configLoadFailed = (commit: string, message: string) => failureReply(`Couldn't load \`.achq/\` at ${commit.slice(0, SHORT_COMMIT)}: ${message}`);

export const worktreeFailed = (message: string) => failureReply(`Couldn't set up the worktree: ${message}`);

/** `sessions` lists the interrupted sessions, e.g. `coder \`<id>\``. */
export const runInterrupted = (sessions: string) =>
  `${WARNING} The agent restarted while a run was in progress. The work so far is in the worktree and the session is intact; the next message resumes it.\n\n<sub>${sessions}</sub>\n`;

export const threadBusy = (workspace: string) => `An agent is working on this thread in ${workspace}. Try again when its run finishes.`;

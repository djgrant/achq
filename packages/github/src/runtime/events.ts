import type { ChannelEvent, Data } from "@achq/core";
import { CHANNEL, COMMENT_ACTIONS, CONFIG_DIR, INSTALLATION_ACTIONS, INSTALLATION_REPOS_ACTIONS, ISSUE_ACTIONS, PUSH_COMMIT_CAP, TRUSTED } from "../constants.ts";
import { labelNames } from "./labels.ts";
import { messageId, OPENING_POST_ID } from "./messages.ts";
import { issueThreadId } from "./threads.ts";

const fullNames = (repos: unknown): string[] =>
  Array.isArray(repos) ? repos.map((r) => r?.full_name).filter((n): n is string => typeof n === "string") : [];

/**
 * Normalises a verified delivery. Never carries the raw payload: only what the
 * router filters on and the container needs later.
 */
export const parseEvent = (source: string, headers: Headers, body: string): ChannelEvent | undefined => {
  const name = headers.get("x-github-event");
  const delivery = headers.get("x-github-delivery");
  if (!name || !delivery) return undefined;
  let p: any;
  try {
    p = JSON.parse(body);
  } catch {
    return undefined;
  }
  const base = { channel: CHANNEL, source, delivery };
  const repo: string | undefined = p.repository?.full_name;

  if (name === "issues" || name === "issue_comment") {
    const issue = p.issue;
    if (!repo || !issue || issue.pull_request) return undefined;
    if (!(name === "issues" ? ISSUE_ACTIONS : COMMENT_ACTIONS).has(p.action)) return undefined;
    const comment = name === "issue_comment" ? p.comment : undefined;
    if (name === "issue_comment" && !comment) return undefined;
    const author = comment ?? issue;
    const text: string = author.body ?? "";
    const detail: { [key: string]: Data } = { issue: issue.number };
    if (comment) detail.comment = comment.id;
    if (p.action === "labeled" && p.label?.name) detail.label = p.label.name;
    return {
      ...base,
      type: `${name}.${p.action}`,
      repo,
      thread: { channel: CHANNEL, id: issueThreadId(repo, issue.number) },
      labels: labelNames(issue.labels),
      actor: {
        login: author.user?.login ?? "",
        // Content is only trusted when both the issue and the comment come from people with write access.
        trusted: TRUSTED.has(author.author_association) && TRUSTED.has(issue.author_association),
        bot: author.user?.type === "Bot",
      },
      text,
      // An edit that didn't touch the body (e.g. a title change) has no `changes.body`: the text before is the text now.
      ...(p.action === "edited" && { previousText: typeof p.changes?.body?.from === "string" ? p.changes.body.from : text }),
      message: comment ? messageId(comment.id) : OPENING_POST_ID,
      detail,
    };
  }

  if (name === "push") {
    if (!repo) return undefined;
    const commits: any[] = Array.isArray(p.commits) ? p.commits : [];
    const touchesConfig = commits.some((c) =>
      [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f: string) => f.startsWith(CONFIG_DIR)),
    );
    return {
      ...base,
      type: "push",
      repo,
      detail: {
        ref: p.ref ?? "",
        defaultBranch: p.repository?.default_branch ?? "",
        after: p.after ?? "",
        deleted: Boolean(p.deleted),
        touchesConfig,
        truncated: commits.length >= PUSH_COMMIT_CAP,
      },
    };
  }

  if (name === "installation" || name === "installation_repositories") {
    const actions = name === "installation" ? INSTALLATION_ACTIONS : INSTALLATION_REPOS_ACTIONS;
    if (!actions.has(p.action)) return undefined;
    const added = name === "installation" ? (p.action === "created" ? fullNames(p.repositories) : []) : fullNames(p.repositories_added);
    const removed = name === "installation" ? (p.action === "deleted" ? fullNames(p.repositories) : []) : fullNames(p.repositories_removed);
    return {
      ...base,
      type: `${name}.${p.action}`,
      detail: {
        installation: p.installation?.id ?? 0,
        account: p.installation?.account?.login ?? "",
        // For suspend and unsuspend, the repos the installation covers (when GitHub lists them).
        repos: fullNames(p.repositories),
        added,
        removed,
      },
    };
  }
  return undefined;
};

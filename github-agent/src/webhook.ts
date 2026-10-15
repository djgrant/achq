export { verifySignature } from "./router.ts";

export const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type Job = { issue: number; commentId: number; author: string; body: string };

/**
 * Turns a webhook delivery into a job, or says why it was skipped. Only issue
 * comments that mention the trigger, on issues opened by and in comments
 * written by users with write access, start a run.
 */
export const jobFrom = (
  event: string | null,
  payload: any,
  { repo, trigger }: { repo: string; trigger: string },
): Job | { skip: string } => {
  if (event !== "issue_comment" || payload.action !== "created") return { skip: "not a new issue comment" };
  if (payload.repository?.full_name?.toLowerCase() !== repo.toLowerCase()) return { skip: "other repo" };
  const { issue, comment } = payload;
  if (issue.pull_request) return { skip: "pull request" };
  if (comment.user?.type === "Bot") return { skip: "bot comment" };
  if (!comment.body?.includes(trigger)) return { skip: "no mention" };
  if (!TRUSTED.has(comment.author_association)) return { skip: "untrusted commenter" };
  if (!TRUSTED.has(issue.author_association)) return { skip: "untrusted issue author" };
  return { issue: issue.number, commentId: comment.id, author: comment.user.login, body: comment.body };
};

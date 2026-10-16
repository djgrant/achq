import * as fs from "node:fs";
import * as path from "node:path";
import { render } from "./template.ts";
import { TRUSTED } from "./webhook.ts";

export type Comment = {
  id: number;
  body: string;
  created_at: string;
  author_association: string;
  user: { login: string; type: string };
};

export type Issue = { number: number; title: string; body: string | null; html_url: string };

export type PromptInput = {
  mode: "new" | "resume";
  issue: Issue;
  comments: Comment[];
  /** Comments up to this ID were already given to the session. */
  since: number;
  bodyChanged: boolean;
  author: string;
  bot: string;
  branch: string;
  head: string;
};

const TEMPLATES = path.join(import.meta.dir, "..", "prompts");

/**
 * Renders prompts/new.md or prompts/resume.md from trusted content only: the
 * issue body and comments by users with write access. New sessions also see the
 * bot's earlier comments, since they don't remember writing them.
 */
export const buildPrompt = (input: PromptInput): { prompt: string; included: number; omitted: number } => {
  const { mode, issue, since } = input;
  const fresh = input.comments.filter((c) => c.id > since);
  const included = fresh.filter(
    (c) => TRUSTED.has(c.author_association) || (mode === "new" && c.user.login === input.bot),
  );
  const omitted = fresh.filter((c) => c.user.login !== input.bot && !TRUSTED.has(c.author_association)).length;

  const prompt = render(fs.readFileSync(path.join(TEMPLATES, `${mode}.md`), "utf8"), {
    issue: { number: issue.number, title: issue.title, url: issue.html_url, body: issue.body?.trim() || "(empty)" },
    comments: included.map((c) => ({ author: c.user.login, date: c.created_at, body: c.body.trim() })),
    omitted,
    bodyChanged: input.bodyChanged,
    branch: input.branch,
    head: input.head,
    mentionedBy: input.author,
  });
  return { prompt, included: included.length, omitted };
};

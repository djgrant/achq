import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message, Thread } from "@achq/core";
import Mustache from "mustache";
import { PROMPTS } from "./constants.ts";

export type PromptInput = {
  mode: "new" | "resume";
  thread: Thread;
  /** The opening post first, then replies in order. */
  messages: Message[];
  /** Resume: the newest message the session has already seen. */
  since?: string;
  /** Resume: the opening post's hash as the session last saw it. */
  opening?: string;
  /**
   * Resume: the message an edit that started this run is about. The session may
   * have seen it before the edit, so it's shown again even if it's not new.
   */
  edited?: string;
  /** The trigger's mention, e.g. `@claude`, so `/new` can be stripped after it. */
  mention?: string;
  /** Who started the run. */
  by: string;
  branch: string;
  head: string;
};

export type Prompt = {
  prompt: string;
  /** Messages given to the session (an edited opening post counts as one). */
  included: number;
  omitted: number;
  lastMessage?: string;
  opening: string;
};

export const hashBody = (body: string) => createHash("sha256").update(body).digest("hex");

/**
 * Renders prompts/new.md or prompts/resume.md from trusted messages only.
 * New sessions also see the channel's own earlier replies, since they don't
 * remember writing them. Untrusted messages are counted, never shown.
 */
export const buildPrompt = (input: PromptInput): Prompt => {
  const [first, ...replies] = input.messages;
  const openingTrusted = Boolean(first && (first.trusted || first.own));
  const opening = hashBody(first?.body ?? "");
  const body = !first
    ? "(empty)"
    : openingTrusted
      ? first.body.trim() || "(empty)"
      : "(Left out: the opening post is by a user without write access.)";

  let fresh = replies;
  if (input.mode === "resume" && input.since) {
    const at = replies.findIndex((m) => m.id === input.since);
    // The opening post, or a message since deleted: everything after it is new.
    if (at >= 0) fresh = replies.slice(at + 1);
  }
  const edited = input.mode === "resume" && input.edited ? replies.find((m) => m.id === input.edited) : undefined;
  if (edited && !fresh.includes(edited)) fresh = [edited, ...fresh];
  const shown = fresh.filter((m) => m.trusted || (input.mode === "new" && m.own));
  const omitted = fresh.filter((m) => !m.trusted && !m.own).length + (input.mode === "new" && first && !openingTrusted ? 1 : 0);
  const bodyChanged = input.mode === "resume" && openingTrusted && input.opening !== undefined && input.opening !== opening;

  const template = fs.readFileSync(path.join(PROMPTS, `${input.mode}.md`), "utf8");
  const view = {
    thread: { id: input.thread.ref.id, title: input.thread.title, url: input.thread.url, body },
    messages: shown.map((m) => ({ author: m.author, date: m.at, body: stripNew(m.body, input.mention).trim() })),
    omitted,
    bodyChanged,
    branch: input.branch,
    head: input.head,
    by: input.by,
  };
  // The prompt is markdown, not HTML: values go in as written.
  const prompt = Mustache.render(template, view, {}, { escape: String });
  return { prompt, included: shown.length + (bodyChanged ? 1 : 0), omitted, lastMessage: input.messages.at(-1)?.id, opening };
};

/** `/new` is for the runner. The agent only needs what follows it. */
const stripNew = (body: string, mention?: string) =>
  mention ? body.replace(new RegExp(`(${mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s+/new(?![\\w-])`, "g"), "$1") : body;

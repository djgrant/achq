import * as fs from "node:fs";
import * as path from "node:path";
import type { Message, Thread } from "@achq/core";
import { crypto } from "@achq/utils/crypto";
import { text } from "@achq/utils/text";
import Mustache from "mustache";

const PROMPTS = path.join(import.meta.dir, "..", "..", "prompts");
const EMPTY = "(empty)";
const UNTRUSTED_OPENING = "(Left out: the opening post is by a user without write access.)";

export type Mode = "resume" | "new" | "compact";
export type Command = { mode: Mode; text: string };

/**
 * The command in a comment is whatever follows the first trigger:
 *   @claude <prompt>          resume the issue's session (or start one)
 *   @claude /new <prompt>     start a fresh session
 *   @claude /compact [focus]  compact the issue's session
 */
export const parseCommand = (body: string, trigger: string) => {
  const at = body.indexOf(trigger);
  let rest = (at < 0 ? body : body.slice(at + trigger.length)).trimStart();
  let mode: Mode = "resume";
  for (const m of ["new", "compact"] as const) {
    if (new RegExp(`^/${m}(?![\\w-])`).test(rest)) {
      mode = m;
      rest = rest.slice(m.length + 1).trimStart();
      break;
    }
  }
  return { mode, text: rest.trimEnd() };
};

/** achq's system prompt, which every agent gets before the repo's. */
export const runnerPrompt = () => fs.readFileSync(path.join(PROMPTS, "system.md"), "utf8");

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

/**
 * Renders prompts/new.md or prompts/resume.md from trusted messages only.
 * New sessions also see the channel's own earlier replies, since they don't
 * remember writing them. Untrusted messages are counted, never shown.
 */
export const buildPrompt = (input: PromptInput) => {
  const [first, ...replies] = input.messages;
  const isNew = input.mode === "new";
  const openingTrusted = Boolean(first && (first.trusted || first.own));
  const opening = crypto.sha256Hex(first?.body ?? "");

  const unseen = unseenReplies(input, replies);
  const shown = unseen.filter((m) => m.trusted || (isNew && m.own));
  const omitted = unseen.filter((m) => !m.trusted && !m.own).length + (isNew && first && !openingTrusted ? 1 : 0);
  const bodyChanged = !isNew && openingTrusted && input.opening !== undefined && input.opening !== opening;
  const body = !first ? EMPTY : !openingTrusted ? UNTRUSTED_OPENING : first.body.trim() || EMPTY;

  // The prompt is markdown, not HTML: values go in as written.
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
  const prompt = Mustache.render(template, view, {}, { escape: String });
  return { prompt, included: shown.length + (bodyChanged ? 1 : 0), omitted, lastMessage: input.messages.at(-1)?.id, opening } satisfies Prompt;
};

/** Every reply for a new session; for a resumed one, those after `since`, plus the edited one. */
const unseenReplies = (input: PromptInput, replies: Message[]) => {
  if (input.mode === "new") return replies;
  const at = input.since ? replies.findIndex((m) => m.id === input.since) : -1;
  // The opening post, or a message since deleted: everything after it is new.
  const after = at >= 0 ? replies.slice(at + 1) : replies;
  const edited = input.edited ? replies.find((m) => m.id === input.edited) : undefined;
  return edited && !after.includes(edited) ? [edited, ...after] : after;
};

/** `/new` is for the runner. The agent only needs what follows it. */
const stripNew = (body: string, mention?: string) => (mention ? body.replace(new RegExp(`(${text.escapeRegExp(mention)})\\s+/new(?![\\w-])`, "g"), "$1") : body);

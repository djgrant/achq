import { type ChannelEvent, EventSelector, type SelectorData, type ThreadRef, ThreadSelector } from "@achq/core";
import { text } from "@achq/utils/text";
import { CHANNEL } from "./constants.ts";

export type EventSelectorData = {
  channel: typeof CHANNEL;
  source: string;
  event: "issues" | "issue_comment";
  actions: string[];
  /** Only when the text newly mentions this, e.g. "@claude". For edits, a mention already there before doesn't count. */
  mention?: string;
  /** Only on threads with all of these labels. */
  labels?: string[];
};

export type IssueAction = "opened" | "edited" | "reopened" | "labeled";
export type CommentAction = "created" | "edited";

export const eventSelector = (source: string, event: EventSelectorData["event"], actions: string[], options: { mention?: string; labels?: string[] }) => {
  const data: EventSelectorData = {
    channel: CHANNEL,
    source,
    event,
    actions,
    ...(options.mention && { mention: options.mention }),
    ...(options.labels && { labels: options.labels }),
  };
  return new EventSelector(data);
};

/** Labels a thread must all have. */
export type IssueFilter = { labels?: string[] };

export type IssueSelectorData = { channel: typeof CHANNEL; source: string; kind: "issue"; labels?: string[] };

/** The App's issues, or the ones matching a filter. A description, not a list. */
export class Issues extends ThreadSelector {
  declare readonly data: IssueSelectorData;
  constructor(source: string, filter: IssueFilter = {}) {
    super({ channel: CHANNEL, source, kind: "issue", ...(filter.labels && { labels: filter.labels }) });
  }
  where(filter: IssueFilter) {
    return new Issues(this.data.source, { labels: [...(this.data.labels ?? []), ...(filter.labels ?? [])] });
  }
}

/**
 * Whether `body` mentions `mention` as GitHub would: case-insensitively, and
 * not as part of a longer name or address (`@claudette`, `me@claude.ai`).
 */
export const mentions = (body: string | undefined, mention: string) =>
  body !== undefined && new RegExp(`(?<![\\w@.-])${text.escapeRegExp(mention)}(?![\\w-])`, "i").test(body);

export const matchEvent = (selector: SelectorData, event: ChannelEvent) => {
  const s = selector as Partial<EventSelectorData>;
  if (s.channel !== CHANNEL || event.channel !== CHANNEL || s.source !== event.source) return false;
  if (typeof s.event !== "string" || !Array.isArray(s.actions)) return false;
  const [name, action] = event.type.split(".");
  if (name !== s.event || !action || !s.actions.includes(action)) return false;
  if (s.labels?.some((l) => !event.labels?.includes(l))) return false;
  if (s.mention) {
    if (!mentions(event.text, s.mention)) return false;
    // A mention only counts if it wasn't in the text before the edit.
    if (action === "edited" && (event.previousText === undefined || mentions(event.previousText, s.mention))) return false;
  }
  return true;
};

export const matchThread = (selector: SelectorData, thread: { ref: ThreadRef; labels: string[] }) => {
  const s = selector as Partial<IssueSelectorData>;
  if (s.channel !== CHANNEL || thread.ref.channel !== CHANNEL || s.kind !== "issue") return false;
  return (s.labels ?? []).every((l) => thread.labels.includes(l));
};

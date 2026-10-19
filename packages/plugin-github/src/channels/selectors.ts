import { EventSelector } from "@achq/core";
import { CHANNEL } from "../lib/constants.ts";

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

/** A selector for an App's `event` webhooks with these actions. */
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

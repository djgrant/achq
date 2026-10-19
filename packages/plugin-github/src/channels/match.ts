import type { ChannelEvent, SelectorData, ThreadRef } from "@achq/core";
import { CHANNEL } from "../lib/constants.ts";
import type { EventSelectorData } from "./selectors.ts";
import type { IssueSelectorData } from "./issues.ts";
import { mentions } from "./mentions.ts";

export const matchEvent = (selector: SelectorData, event: ChannelEvent): boolean => {
  const s = selector as Partial<EventSelectorData>;
  if (s.channel !== CHANNEL || event.channel !== CHANNEL || s.source !== event.source) return false;
  if (typeof s.event !== "string" || !Array.isArray(s.actions)) return false;
  const [name, action] = event.type.split(".");
  if (name !== s.event || !action || !s.actions.includes(action)) return false;
  if (!event.actor || event.actor.bot || !event.actor.trusted) return false;
  if (s.labels?.some((l) => !event.labels?.includes(l))) return false;
  if (s.mention) {
    if (!mentions(event.text, s.mention)) return false;
    // A mention only counts if it wasn't in the text before the edit.
    if (action === "edited" && (event.previousText === undefined || mentions(event.previousText, s.mention))) return false;
  }
  return true;
};

export const matchThread = (selector: SelectorData, thread: { ref: ThreadRef; labels: string[] }): boolean => {
  const s = selector as Partial<IssueSelectorData>;
  if (s.channel !== CHANNEL || thread.ref.channel !== CHANNEL || s.kind !== "issue") return false;
  return (s.labels ?? []).every((l) => thread.labels.includes(l));
};

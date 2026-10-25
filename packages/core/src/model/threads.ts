/** A thread's identity, qualified by channel. `id` is e.g. `notationlabs/yieldstar#42`. */
export type ThreadRef = { channel: string; id: string };

export const threadKey = (ref: ThreadRef) => `${ref.channel}:${ref.id}`;

export type Thread = {
  ref: ThreadRef;
  title: string;
  url: string;
  labels: string[];
  /** Fills branch templates: `{number}`, `{title}` (slugified). */
  vars: Record<string, string>;
};

/** The thread's opening post first, then replies in order. */
export type Message = {
  id: string;
  author: string;
  trusted: boolean;
  /** Written by this channel's own identity, i.e. an earlier reply. */
  own: boolean;
  body: string;
  at: string;
  /** For the opening post: whether it changed since `since` in `messages()`. */
  edited?: boolean;
};

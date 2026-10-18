const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` mentions `mention` as GitHub would: case-insensitively, and
 * not as part of a longer name or address (`@claudette`, `me@claude.ai`).
 */
export const mentions = (text: string | undefined, mention: string) =>
  text !== undefined && new RegExp(`(?<![\\w@.-])${escape(mention)}(?![\\w-])`, "i").test(text);

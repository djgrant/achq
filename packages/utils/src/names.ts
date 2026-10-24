// Not in text.ts, which the config sandbox loads without node:crypto.
import { crypto } from "./crypto.ts";

/** How much of a too-long slug's hash tells it apart from others cut to the same prefix. */
const SLUG_HASH_CHARS = 8;

export const names = {
  /** `parts` as one name of lowercase letters, digits and dashes, at most `max` long: one too long is cut to fit, ending in a hash of the whole of it. */
  slug: (parts: string[], max: number) => {
    const name = parts
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (name.length <= max) return name;
    const prefix = name.slice(0, max - SLUG_HASH_CHARS - 1).replace(/-$/, "");
    return `${prefix}-${crypto.sha256Hex(name, SLUG_HASH_CHARS)}`;
  },
};

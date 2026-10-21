import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const crypto = {
  hmacHex: (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex"),

  /** Compares in time that doesn't depend on where they differ, so a signature can't be guessed byte by byte. */
  safeEqual: (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  },

  /** Cut to its first `length` hex characters when given: a fingerprint, not a security boundary. */
  sha256Hex: (data: string, length?: number) => createHash("sha256").update(data).digest("hex").slice(0, length),

  randomHex: (bytes: number) => randomBytes(bytes).toString("hex"),
};

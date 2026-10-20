// Hashes, signatures and secrets, all as lowercase hex so they fit in env
// variables, file names and headers.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 of `data` keyed by `secret`. */
export const hmacHex = (secret: string, data: string): string => createHmac("sha256", secret).update(data).digest("hex");

/** Compares in time that doesn't depend on where they differ, so a signature can't be guessed byte by byte. */
export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** SHA-256 of `data`, cut to its first `length` hex characters when given: a fingerprint, not a security boundary. */
export const sha256Hex = (data: string, length?: number): string => createHash("sha256").update(data).digest("hex").slice(0, length);

/** `bytes` random bytes: a fresh secret or nonce. */
export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

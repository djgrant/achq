// Requests between achq's services are signed over the method, path, timestamp
// and body, so a captured request can't be replayed elsewhere or later.
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_MS = 5 * 60_000;

export const hmacHex = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const signature = (secret: string, method: string, path: string, timestamp: string, body: string) =>
  hmacHex(secret, `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`);

export const signedHeaders = (secret: string, method: string, path: string, body: string, now = Date.now()) => {
  const timestamp = String(now);
  return { "x-achq-timestamp": timestamp, "x-achq-signature": signature(secret, method, path, timestamp, body) };
};

export const verifySigned = (secret: string, method: string, path: string, body: string, headers: Headers, now = Date.now()) => {
  const timestamp = headers.get("x-achq-timestamp");
  const signed = headers.get("x-achq-signature");
  if (!timestamp || !signed || Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false;
  return safeEqual(signed, signature(secret, method, path, timestamp, body));
};

/** `fetch` with a signed request. The signature covers `url`'s path and query. */
export const signedFetch = (secret: string, url: string, init: { method: string; body?: string; headers?: Record<string, string> }) => {
  const { pathname, search } = new URL(url);
  const body = init.body ?? "";
  return fetch(url, {
    method: init.method,
    body: init.body,
    headers: { ...init.headers, ...(init.body !== undefined && { "content-type": "application/json" }), ...signedHeaders(secret, init.method, pathname + search, body) },
  });
};

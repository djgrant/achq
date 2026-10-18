// Every secret derives from AGENT_WEBHOOK_KEY. Each derivation has its own
// label, so no two collide.
import { createHmac, timingSafeEqual } from "node:crypto";

const derive = (key: string, label: string) => createHmac("sha256", key).update(label).digest("hex");

/** A GitHub App's webhook secret, from its App ID (sent in X-GitHub-Hook-Installation-Target-ID). */
export const appWebhookSecret = (key: string, appId: string | number) => derive(key, `github-app-webhook:${appId}`);

/** A container signs its requests to the router with this. The router signs events to the container with it too. */
export const containerSecret = (key: string, repo: string, container: string) =>
  derive(key, `container:${repo.toLowerCase()}:${container}`);

/** Signs requests between the router, the deployer and the infra CLI. */
export const adminSecret = (key: string) => derive(key, "admin");

export const hmacHex = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Checks GitHub's X-Hub-Signature-256 header against the raw body. */
export const verifyGitHubSignature = (secret: string, body: string, header: string | null) =>
  Boolean(header?.startsWith("sha256=")) && safeEqual(header!, `sha256=${hmacHex(secret, body)}`);

const MAX_SKEW_MS = 5 * 60_000;

/**
 * Headers for a request signed with `secret`: over the method, path, timestamp
 * and body, so a captured request can't be replayed elsewhere or later.
 */
export const signedHeaders = (secret: string, method: string, path: string, body: string, now = Date.now()) => {
  const timestamp = String(now);
  return {
    "x-achq-timestamp": timestamp,
    "x-achq-signature": hmacHex(secret, `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`),
  };
};

export const verifySigned = (secret: string, method: string, path: string, body: string, headers: Headers, now = Date.now()) => {
  const timestamp = headers.get("x-achq-timestamp");
  const signature = headers.get("x-achq-signature");
  if (!timestamp || !signature || Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false;
  return safeEqual(signature, hmacHex(secret, `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`));
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

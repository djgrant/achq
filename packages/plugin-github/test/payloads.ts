import { crypto } from "@achq/utils/crypto";
import { makeApp } from "@achq/test-utils/github";
import { githubChannelProvider } from "../src/channel/index.ts";
import { type AppKeys, appWebhookSecret } from "../src/lib/apps.ts";

export const KEY = "the-webhook-key";

/** The env a side makes GitHub's parts from: the router's has App keys and AGENT_WEBHOOK_KEY, and tests point the API at a fake. */
export const githubEnv = (apps?: AppKeys, api?: string, key?: string) => ({
  ...(apps && { ACHQ_GITHUB_APPS: JSON.stringify(apps) }),
  ...(api && { GITHUB_API_URL: api }),
  ...(key && { AGENT_WEBHOOK_KEY: key }),
});

// ─── Payloads, shaped from https://docs.github.com/en/webhooks/webhook-events-and-payloads ───

export const repository = { id: 1, name: "yieldstar", full_name: "notationlabs/yieldstar", owner: { login: "notationlabs" }, default_branch: "main" };
export const installation = { id: 77, node_id: "MDIz" };
export const user = (login: string, type = "User") => ({ login, id: login.length, type, site_admin: false });

export const issuePayload = (over: { author?: string; association?: string; body?: string; labels?: string[]; pr?: boolean; type?: string } = {}) => ({
  url: "https://api.github.com/repos/notationlabs/yieldstar/issues/42",
  html_url: "https://github.com/notationlabs/yieldstar/issues/42",
  number: 42,
  title: "Fix the thing",
  user: user(over.author ?? "dan", over.type),
  labels: (over.labels ?? ["docs"]).map((name, id) => ({ id, name, color: "fff" })),
  state: "open",
  author_association: over.association ?? "OWNER",
  body: over.body ?? "Please fix it",
  ...(over.pr && { pull_request: { url: "https://api.github.com/repos/notationlabs/yieldstar/pulls/42" } }),
});

export const commentPayload = (action: string, over: { body?: string; from?: string; association?: string; author?: string; type?: string; issue?: object } = {}) => ({
  action,
  issue: over.issue ?? issuePayload(),
  comment: {
    id: 9001,
    html_url: "https://github.com/notationlabs/yieldstar/issues/42#issuecomment-9001",
    user: user(over.author ?? "dan", over.type),
    created_at: "2026-10-18T10:00:00Z",
    updated_at: "2026-10-18T10:00:00Z",
    author_association: over.association ?? "OWNER",
    body: over.body ?? "@claude please look",
  },
  ...(over.from !== undefined && { changes: { body: { from: over.from } } }),
  repository,
  sender: user(over.author ?? "dan"),
  installation,
});

export const headers = (event: string, body: string, over: Record<string, string | null> = {}) => {
  const h = new Headers({
    "x-github-event": event,
    "x-github-delivery": "d-1",
    "x-github-hook-installation-target-id": "101",
    "x-github-hook-installation-target-type": "integration",
    "x-hub-signature-256": `sha256=${crypto.hmacHex(appWebhookSecret(KEY, "101"), body)}`,
  });
  for (const [k, v] of Object.entries(over)) v === null ? h.delete(k) : h.set(k, v);
  return h;
};

export const appA = makeApp("notation-achq", "101", { issues: "write", contents: "write", metadata: "read" });
export const appB = makeApp("djgrant-claude", "202", { issues: "write", contents: "read", metadata: "read" });
export const keys = { [appA.slug]: { id: appA.id, privateKey: appA.privateKey }, [appB.slug]: { id: appB.id, privateKey: appB.privateKey } };
export const channel = githubChannelProvider.create(githubEnv(keys, undefined, KEY));
const parseAny = (event: string, payload: object) => {
  const body = JSON.stringify(payload);
  return channel.parse("notation-achq", headers(event, body), body);
};

/** A delivery that's an event on a thread, or undefined. */
export const parse = (event: string, payload: object) => {
  const parsed = parseAny(event, payload);
  if (parsed?.to === "deployer") throw new Error(`${event} parsed to a repo event`);
  return parsed?.event;
};

/** A delivery that's about which repos to deploy, or undefined. */
export const parseRepo = (event: string, payload: object) => {
  const parsed = parseAny(event, payload);
  if (parsed?.to === "containers") throw new Error(`${event} parsed to a channel event`);
  return parsed?.event;
};

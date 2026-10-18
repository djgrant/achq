// The router over real HTTP. The fake containers, deployer and GitHub API are
// real servers that check the signatures they receive. A temp dir is its volume.
import { afterEach, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, PolicyData, SelectorData, AccessProvider, Channel, ChannelEvent, RepoHost, RouterRepoConfig } from "@achq/core";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { hmacHex, safeEqual, signedHeaders, verifySigned } from "@achq/core/signing";
import { createRouter } from "../src/router.ts";

export const key = "test-key";
export const repo = "acme/widgets";
export const hour = () => new Date(Date.now() + 3_600_000).toISOString();

// ─── A channel and a provider of our own ─────────────────────────────────────

/** Each source's webhook secret, derived from the key the way the GitHub channel does. */
export const sourceSecret = (source: string) => hmacHex(key, `test-source:${source}`);
export const SOURCES = ["app"];

/** Deliveries are a ChannelEvent's fields as JSON, signed per source. */
export const testChannel: Channel = {
  id: "test",
  async verify(headers, body) {
    const source = headers.get("x-test-source") ?? "";
    const signature = headers.get("x-test-signature") ?? "";
    return SOURCES.includes(source) && safeEqual(signature, hmacHex(sourceSecret(source), body)) ? source : undefined;
  },
  parse(source, _headers, body) {
    const data = JSON.parse(body);
    if (data.type === "ping") return undefined;
    return { channel: "test", source, detail: {}, ...data };
  },
  async mintClient(source, forRepo) {
    return { provider: "test-client", value: `client:${source}:${forRepo}`, expiresAt: hour(), scope: { source, repo: forRepo } };
  },
  matchEvent: (selector, event) => selector.type === event.type,
  matchThread: (selector, thread) => ((selector.labels as string[] | undefined) ?? []).every((l) => thread.labels.includes(l)),
  client() {
    throw new Error("not on the router");
  },
};

export const testProvider: AccessProvider = {
  id: "test",
  validate: async (policy) => (policy.ok === false ? [`${policy.name} isn't allowed`] : []),
  mint: async (policies, forRepo) =>
    policies.map((p) => ({ provider: "test", value: `token:${p.name}`, expiresAt: hour(), scope: { repo: forRepo, policy: p.name } })),
  install: async () => ({ env: {} }),
};

/** `push-token` can push to `repo`; `read-token` and anything else can't. */
export const testHost: RepoHost = {
  repoName: /^[\w.-]+\/[\w.-]+$/,
  deployerPolicy: (source, forRepo) => ({ provider: "test", source, repo: forRepo }),
  repo() {
    throw new Error("not on the router");
  },
  canPush: async (forRepo, token) => forRepo === repo && token === "push-token",
  cloneUrl: (forRepo) => `https://test.example/${forRepo}.git`,
};

// ─── Fake services ───────────────────────────────────────────────────────────

export const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});
export const serve = (fetch: (req: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return `http://localhost:${server.port}`;
};

export type Respond = (req: Request) => Response | Promise<Response>;
export const accepted = () => new Response("ok", { status: 202 });

/** A container that only accepts events signed with its own secret. */
export const fakeContainer = (name: string, forRepo = repo) => {
  const fake = {
    name,
    events: [] as EventEnvelope[],
    /** Every attempt that reached it, signed or not. */
    attempts: 0,
    wakes: 0,
    respond: accepted as Respond,
    wakeRespond: (() => new Response("ok")) as Respond,
    url: "",
  };
  fake.url = serve(async (req) => {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/") {
      fake.wakes++;
      return fake.wakeRespond(req);
    }
    fake.attempts++;
    const body = await req.text();
    if (!verifySigned(containerSecret(key, forRepo, name), "POST", "/events", body, req.headers)) return new Response("bad signature", { status: 401 });
    fake.events.push(JSON.parse(body));
    return fake.respond(req);
  });
  return fake;
};

/** The deployer: admin-signed in, as the protocol says. */
export const fakeDeployer = () => {
  const fake = { events: [] as EventEnvelope[], syncs: 0, url: "" };
  fake.url = serve(async (req) => {
    const { pathname } = new URL(req.url);
    const body = await req.text();
    if (!verifySigned(adminSecret(key), req.method, pathname, body, req.headers)) return new Response("bad signature", { status: 401 });
    if (pathname === "/events") fake.events.push(JSON.parse(body));
    if (pathname === "/sync") return ++fake.syncs < 2 ? new Response("waking", { status: 503 }) : Response.json({ deployed: [repo], unchanged: [], uninstalled: [], pruned: [], failed: [] });
    if (pathname === "/status") return Response.json([{ repo, state: "deployed" }]);
    return accepted();
  });
  return fake;
};

// ─── The router ──────────────────────────────────────────────────────────────

export type Boot = { dir?: string; deployer?: string; delays?: number[] };

export const boot = async ({ dir = mkdtempSync(join(tmpdir(), "achq-router-")), deployer = "http://localhost:1", delays = [0, 0] }: Boot = {}) => {
  const router = createRouter({
    channels: [testChannel],
    providers: [testProvider],
    hosts: { test: testHost },
    key,
    dataDir: dir,
    deployerUrl: deployer,
    installations: async () => [{ provider: "test", source: "app", repo }],
    sources: async () => [{ channel: "test", source: "app", events: ["comment"], permissions: {} }],
    delays,
    log: () => {},
  });
  await router.start();
  const pub = serve(router.publicFetch);
  const priv = serve(router.privateFetch);

  const signedRequest = (base: string, secret: string, method: string, path: string, body?: object, at = Date.now()) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return fetch(`${base}${path}`, { method, body: text, headers: signedHeaders(secret, method, path, text ?? "", at) });
  };
  return {
    dir,
    router,
    pub,
    priv,
    admin: (method: string, path: string, body?: object, base = priv) => signedRequest(base, adminSecret(key), method, path, body),
    asContainer: (forRepo: string, container: string, path: string, body: object, at?: number, base = priv) =>
      signedRequest(base, containerSecret(key, forRepo, container), "POST", path, body, at),
    webhook: (event: Partial<ChannelEvent>, secret = sourceSecret("app")) => {
      const body = JSON.stringify(event);
      return fetch(`${pub}/webhook`, { method: "POST", body, headers: { "x-test-source": "app", "x-test-signature": hmacHex(secret, body) } });
    },
    wake: (body: object, token?: string) =>
      fetch(`${pub}/wake`, { method: "POST", body: JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} }),
  };
};

// Two containers. `dev` has a docs workspace before its catch-all; `docsbox` only takes docs threads.
export const selector = (labels?: string[]): SelectorData => ({ channel: "test", source: "app", ...(labels && { labels }) });
export const policy = (name: string): PolicyData => ({ provider: "test", name });
export const config = (dev: { url: string }, docsbox: { url: string }): RouterRepoConfig => ({
  host: "test",
  repo,
  commit: "abc123",
  containers: [
    { name: "dev", url: dev.url, policies: [policy("code"), policy("shared")] },
    { name: "docsbox", url: docsbox.url, policies: [policy("docs-read")] },
  ],
  workspaces: [
    { name: "dev-docs", container: "dev", threads: selector(["docs"]), branch: "docs/{number}", base: "docs" },
    { name: "dev-all", container: "dev", threads: selector(), branch: "issue-{number}", base: "main" },
    { name: "docs", container: "docsbox", threads: selector(["docs"]), branch: "d/{number}", base: "main" },
  ],
  triggers: [{ name: "mention", event: { channel: "test", type: "comment" } }],
});

export const trusted = { login: "dan", trusted: true, bot: false };
let deliveries = 0;
export const comment = (number: number, labels: string[] = [], extra: Partial<ChannelEvent> = {}): Partial<ChannelEvent> => ({
  delivery: `d-${++deliveries}`,
  type: "comment",
  repo,
  thread: { channel: "test", id: `${repo}#${number}` },
  labels,
  actor: trusted,
  ...extra,
});

/** A deployed repo with both containers. */
export const deployed = async (options: Boot = {}) => {
  const dev = fakeContainer("dev");
  const docsbox = fakeContainer("docsbox");
  const r = await boot(options);
  expect((await r.admin("PUT", `/admin/repos/${repo}`, config(dev, docsbox))).status).toBe(204);
  return { ...r, dev, docsbox };
};

export const deliveryIds = (c: { events: EventEnvelope[] }) => c.events.map((e) => e.event.delivery);
export const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Makes a container hold its answer until released, and say when a request has arrived. */
export const hold = (c: ReturnType<typeof fakeContainer>) => {
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  const released = new Promise<void>((r) => (release = r));
  c.respond = async () => {
    arrived();
    await released;
    return accepted();
  };
  return { reached, release };
};

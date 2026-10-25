import { afterEach, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerEnvelope, DeployerEnvelope, PolicyData, SelectorData, PolicyProvider, ChannelProvider, ChannelEvent, CodeHostProvider, RepoEvent, RouterRepoConfig, Stores } from "@achq/core";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { signedRequestInit, verifySigned } from "@achq/core/signing";
import { deployerRoutes } from "@achq/core/routes/deployer";
import { crypto } from "@achq/utils/crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { dirStores } from "@achq/test-utils/helpers/stores";
import { createContext } from "../src/context.ts";
import { replay, settled } from "../src/features/deliveries.ts";
import { routes } from "../src/routes.ts";

export const key = "test-key";
export const repo = "acme/widgets";
export const hour = () => new Date(Date.now() + 3_600_000).toISOString();

/** Each source's webhook secret, derived from the key the way the GitHub channel does. */
export const sourceSecret = (source: string) => crypto.hmacHex(key, `test-source:${source}`);
export const SOURCES = ["app"];

/** Deliveries are a ChannelEvent's or RepoEvent's fields as JSON, signed per source. */
export const testChannel: ChannelProvider = {
  id: "test",
  async verify(headers, body) {
    const source = headers.get("x-test-source") ?? "";
    const signature = headers.get("x-test-signature") ?? "";
    return SOURCES.includes(source) && crypto.safeEqual(signature, crypto.hmacHex(sourceSecret(source), body)) ? source : undefined;
  },
  parse(source, _headers, body) {
    const data = JSON.parse(body);
    if (data.type === "ping") return undefined;
    if ("deploy" in data) return { to: "deployer", event: { uninstall: [], onlyIfDeployed: false, ...data } };
    return { to: "containers", event: { channel: "test", source, detail: {}, ...data } };
  },
  async mintClient(source, forRepo) {
    return { channel: "test", value: `client:${source}:${forRepo}`, expiresAt: hour(), scope: { source, repo: forRepo } };
  },
  matchEvent: (selector, event) => selector.type === event.type,
  matchThread: (selector, thread) => ((selector.labels as string[] | undefined) ?? []).every((l) => thread.labels.includes(l)),
  sources: async () => [{ channel: "test", source: "app", events: ["comment"], permissions: {} }],
  client(credential) {
    const notOnTheRouter = () => {
      throw new Error("not on the router");
    };
    return {
      thread: notOnTheRouter,
      messages: notOnTheRouter,
      acknowledge: notOnTheRouter,
      identity: notOnTheRouter,
      reply: async (thread, body) => {
        channelReplies.push({ thread: thread.id, body, as: String(credential.scope.source) });
      },
    };
  },
};

/** What the router said on threads through the test channel, and as which source. */
export const channelReplies: { thread: string; body: string; as: string }[] = [];

export const testPolicyProvider: PolicyProvider = {
  id: "test",
  validate: async (policy) => (policy.ok === false ? [`${policy.name} isn't allowed`] : []),
  mint: async (policies, forRepo) =>
    policies.map((p) => ({ provider: "test", value: `token:${p.name}`, expiresAt: hour(), scope: { repo: forRepo, policy: p.name } })),
  install: async () => ({ env: {} }),
};

/** `push-token` can push to `repo`; `read-token` and anything else can't. */
export const testHost: CodeHostProvider = {
  repoName: /^[\w.-]+\/[\w.-]+$/,
  deployerPolicy: (forRepo) => ({ provider: "test", repo: forRepo }),
  repo() {
    throw new Error("not on the router");
  },
  canPush: async (forRepo, token) => forRepo === repo && token === "push-token",
  cloneUrl: (forRepo) => `https://test.example/${forRepo}.git`,
  installed: async () => [{ repo }],
  // `app` is installed on `repo`; the router has no other source.
  installation: async (forRepo, source) => (source === "app" ? { installed: forRepo === repo, url: `https://test.example/settings/${source}` } : undefined),
};

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
    events: [] as ContainerEnvelope[],
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

/**
 * The deployer, serving its routes as `@achq/core/routes/deployer` declares
 * them: admin-signed in, as the protocol says. `respond` answers `/events`, as
 * one that's down or a version behind would; its first sync answers as one
 * still waking.
 */
export const fakeDeployer = () => {
  const fake = { events: [] as DeployerEnvelope[], syncs: 0, url: "", respond: accepted as Respond };
  const app = new OpenAPIHono();
  app.use(async (c, next) => {
    const body = await c.req.text();
    if (!verifySigned(adminSecret(key), c.req.method, new URL(c.req.url).pathname, body, c.req.raw.headers)) return c.text("bad signature", 401);
    if (c.req.path === "/events") {
      fake.events.push(JSON.parse(body));
      return fake.respond(c.req.raw);
    }
    if (c.req.path === "/sync" && ++fake.syncs < 2) return c.text("waking", 503);
    await next();
  });
  app.openapi(deployerRoutes.sync, (c) => c.json({ id: "s1" }, 202));
  app.openapi(deployerRoutes.syncStatus, (c) =>
    c.req.valid("param").id === "s1" ? c.json({ state: "done" as const, result: { deployed: [repo], unchanged: [], uninstalled: [], pruned: [], failed: [] } }, 200) : c.text("no such sync", 404),
  );
  app.openapi(deployerRoutes.status, (c) => c.json([{ repo, state: "deployed" as const, at: "2026-10-25T00:00:00.000Z" }], 200));
  app.openapi(deployerRoutes.version, (c) => c.json({ ref: "abc123" }, 200));
  fake.url = serve(app.fetch);
  return fake;
};

/** `stores` is its container provider's store: by default, files under `dir`. */
export type Boot = { dir?: string; deployer?: string; delays?: number[]; stores?: Stores };

export const boot = async ({ dir = mkdtempSync(join(tmpdir(), "achq-router-")), deployer = "http://localhost:1", delays = [0, 0], stores = dirStores(dir) }: Boot = {}) => {
  const ctx = await createContext({ key, deployerUrl: deployer }, { channelProviders: [testChannel], policyProviders: [testPolicyProvider], codeHost: testHost, stores, delays, log: () => {} });
  await replay(ctx);
  const { publicFetch, privateFetch } = routes(ctx);
  const pub = serve(publicFetch);
  const priv = serve(privateFetch);

  const signedRequest = (base: string, secret: string, method: string, path: string, body?: object, at = Date.now()) =>
    fetch(`${base}${path}`, signedRequestInit(secret, method, `${base}${path}`, body === undefined ? undefined : JSON.stringify(body), { now: at }));
  return {
    dir,
    ctx,
    /** Every delivery it accepted has reached its targets. */
    settled: () => settled(ctx),
    pub,
    priv,
    admin: (method: string, path: string, body?: object, base = priv) => signedRequest(base, adminSecret(key), method, path, body),
    asContainer: (forRepo: string, container: string, path: string, body: object, at?: number, base = priv) =>
      signedRequest(base, containerSecret(key, forRepo, container), "POST", path, body, at),
    webhook: (event: Partial<ChannelEvent> | Partial<RepoEvent>, secret = sourceSecret("app")) => {
      const body = JSON.stringify(event);
      return fetch(`${pub}/webhook`, { method: "POST", body, headers: { "x-test-source": "app", "x-test-signature": crypto.hmacHex(secret, body) } });
    },
    /** A public endpoint for the repo CLI, with your code host token. */
    asYou: (path: string, body: object, token?: string) =>
      fetch(`${pub}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) } }),
    wake: (body: object, token?: string) =>
      fetch(`${pub}/wake`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) } }),
  };
};

// Two containers. `dev` has a docs workspace before its catch-all; `docsbox` only takes docs threads.
export const selector = (labels?: string[]) => ({ channel: "test", source: "app", ...(labels && { labels }) }) satisfies SelectorData;
export const policy = (name: string) => ({ provider: "test", name }) satisfies PolicyData;
export const config = (dev: { url: string }, docsbox: { url: string }) => ({
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
  triggers: [{ name: "mention", event: { channel: "test", source: "app", type: "comment" } }],
}) satisfies RouterRepoConfig;

export const trusted = { login: "dan", trusted: true, bot: false };
let deliveries = 0;
export const comment = (number: number, labels: string[] = [], extra: Partial<ChannelEvent> = {}) => ({
  delivery: `d-${++deliveries}`,
  type: "comment",
  repo,
  thread: { channel: "test", id: `${repo}#${number}` },
  labels,
  actor: trusted,
  ...extra,
}) satisfies Partial<ChannelEvent>;

/** A deployed repo with both containers. */
export const deployed = async (options: Boot = {}) => {
  const dev = fakeContainer("dev");
  const docsbox = fakeContainer("docsbox");
  const r = await boot(options);
  expect((await r.admin("PUT", `/admin/repos/${repo}`, config(dev, docsbox))).status).toBe(204);
  return { ...r, dev, docsbox };
};

export const deliveryIds = (c: { events: { event: { delivery: string } }[] }) => c.events.map((e) => e.event.delivery);
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

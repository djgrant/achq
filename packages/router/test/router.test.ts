// The router over real HTTP: its two ports, fake containers, a fake deployer and
// a fake GitHub API as real servers that check the signatures they receive, and
// a temp dir as its volume.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialsResponse, EventEnvelope } from "@achq/core";
import type { PolicyData, SelectorData } from "@achq/core";
import { adminSecret, containerSecret, hmacHex, safeEqual, signedHeaders, verifySigned } from "@achq/core/secrets";
import type { AccessProvider, Channel, ChannelEvent, RouterRepoConfig } from "@achq/core";
import { createRouter } from "../src/router.ts";

const key = "test-key";
const repo = "acme/widgets";
const hour = () => new Date(Date.now() + 3_600_000).toISOString();

// ─── A channel and a provider of our own ─────────────────────────────────────

/** Each source's webhook secret, derived from the key the way the GitHub channel does. */
const sourceSecret = (source: string) => hmacHex(key, `test-source:${source}`);
const SOURCES = ["app"];

/** Deliveries are a ChannelEvent's fields as JSON, signed per source. */
const testChannel: Channel = {
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

const testProvider: AccessProvider = {
  id: "test",
  validate: async (policy) => (policy.ok === false ? [`${policy.name} isn't allowed`] : []),
  mint: async (policies, forRepo) =>
    policies.map((p) => ({ provider: "test", value: `token:${p.name}`, expiresAt: hour(), scope: { repo: forRepo, policy: p.name } })),
  install: async () => ({ env: {} }),
};

// ─── Fake services ───────────────────────────────────────────────────────────

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});
const serve = (fetch: (req: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return `http://localhost:${server.port}`;
};

type Respond = (req: Request) => Response | Promise<Response>;
const accepted = () => new Response("ok", { status: 202 });

/** A container that only accepts events signed with its own secret. */
const fakeContainer = (name: string, forRepo = repo) => {
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
const fakeDeployer = () => {
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

/** GitHub's `GET /repos/{repo}`: `push-token` can push, `read-token` can't. */
const fakeGitHub = () =>
  serve((req) => {
    const token = req.headers.get("authorization");
    if (new URL(req.url).pathname !== `/repos/${repo}`) return new Response("not found", { status: 404 });
    if (token === "Bearer push-token") return Response.json({ permissions: { push: true, pull: true } });
    if (token === "Bearer read-token") return Response.json({ permissions: { push: false, pull: true } });
    return new Response("bad credentials", { status: 401 });
  });

// ─── The router ──────────────────────────────────────────────────────────────

type Boot = { dir?: string; deployer?: string; github?: string; delays?: number[] };

const boot = async ({ dir = mkdtempSync(join(tmpdir(), "achq-router-")), deployer = "http://localhost:1", github, delays = [0, 0] }: Boot = {}) => {
  const router = createRouter({
    channels: [testChannel],
    providers: [testProvider],
    key,
    dataDir: dir,
    deployerUrl: deployer,
    installations: async () => [{ provider: "test", source: "app", repo }],
    sources: async () => [{ channel: "test", source: "app", events: ["comment"], permissions: {} }],
    delays,
    githubApi: github,
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
const selector = (labels?: string[]): SelectorData => ({ channel: "test", source: "app", ...(labels && { labels }) });
const policy = (name: string): PolicyData => ({ provider: "test", name });
const config = (dev: { url: string }, docsbox: { url: string }): RouterRepoConfig => ({
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

const trusted = { login: "dan", trusted: true, bot: false };
let deliveries = 0;
const comment = (number: number, labels: string[] = [], extra: Partial<ChannelEvent> = {}): Partial<ChannelEvent> => ({
  delivery: `d-${++deliveries}`,
  type: "comment",
  repo,
  thread: { channel: "test", id: `${repo}#${number}` },
  labels,
  actor: trusted,
  ...extra,
});

/** A deployed repo with both containers. */
const deployed = async (options: Boot = {}) => {
  const dev = fakeContainer("dev");
  const docsbox = fakeContainer("docsbox");
  const r = await boot(options);
  expect((await r.admin("PUT", `/admin/repos/${repo}`, config(dev, docsbox))).status).toBe(204);
  return { ...r, dev, docsbox };
};

const deliveryIds = (c: { events: EventEnvelope[] }) => c.events.map((e) => e.event.delivery);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Makes a container hold its answer until released, and say when a request has arrived. */
const hold = (c: ReturnType<typeof fakeContainer>) => {
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

// ─── Routing ─────────────────────────────────────────────────────────────────

describe("routing events to containers", () => {
  test("an event reaches only the containers with a workspace that would claim its thread", async () => {
    const r = await deployed();
    const plain = comment(1);
    expect((await r.webhook(plain)).status).toBe(202);
    await r.router.settled();
    expect(deliveryIds(r.dev)).toEqual([plain.delivery!]);
    expect(r.docsbox.events).toEqual([]);
    // Containers get the commit whose config the router holds.
    expect(r.dev.events[0].commit).toBe("abc123");
  });

  test("within a container the first matching workspace in declaration order is chosen", async () => {
    const r = await deployed();
    const gate = hold(r.dev);
    hold(r.docsbox);
    const docs = comment(2, ["docs"]);
    await r.webhook(docs);
    const plain = comment(3);
    await r.webhook(plain);
    const targets = (id: string) => readJson(join(r.dir, "inbox", `${id}.json`)).targets.map((t: any) => `${t.container}:${t.workspace}`);
    // dev-docs is declared before dev-all, so it takes the docs thread; the catch-all takes the rest.
    expect(targets(docs.delivery!)).toEqual(["dev:dev-docs", "docsbox:docs"]);
    expect(targets(plain.delivery!)).toEqual(["dev:dev-all"]);
    gate.release();
  });

  test("a claim keeps its container after relabelling, and another container whose workspace now matches also runs it", async () => {
    const r = await deployed();
    const thread = { channel: "test", id: `${repo}#4` };
    // dev claimed the unlabelled thread with its catch-all.
    expect((await r.asContainer(repo, "dev", "/claims", { repo, container: "dev", workspace: "dev-all", thread })).status).toBe(204);
    // docsbox claimed a docs thread that then loses its label.
    const docsThread = { channel: "test", id: `${repo}#5` };
    expect((await r.asContainer(repo, "docsbox", "/claims", { repo, container: "docsbox", workspace: "docs", thread: docsThread })).status).toBe(204);

    hold(r.dev);
    hold(r.docsbox);
    const relabelled = comment(4, ["docs"]);
    await r.webhook(relabelled);
    const unlabelled = comment(5, []);
    await r.webhook(unlabelled);
    const targets = (id: string) => readJson(join(r.dir, "inbox", `${id}.json`)).targets.map((t: any) => `${t.container}:${t.workspace}`);
    // dev stays on dev-all (the claim), not dev-docs; docsbox joins because its workspace matches now.
    expect(targets(relabelled.delivery!)).toEqual(["dev:dev-all", "docsbox:docs"]);
    // docsbox keeps the thread it claimed, though its selector no longer matches.
    expect(targets(unlabelled.delivery!)).toEqual(["dev:dev-all", "docsbox:docs"]);
  });

  test("claims are container-signed and only for that repo's own containers and workspaces", async () => {
    const r = await deployed();
    const thread = { channel: "test", id: `${repo}#6` };
    const claim = (container: string, workspace: string) => ({ repo, container, workspace, thread });
    // Signed as docsbox, claiming as dev.
    expect((await r.asContainer(repo, "docsbox", "/claims", claim("dev", "dev-all"))).status).toBe(401);
    expect((await r.asContainer(repo, "ghost", "/claims", claim("ghost", "dev-all"))).status).toBe(404);
    // A workspace of another container.
    expect((await r.asContainer(repo, "dev", "/claims", claim("dev", "docs"))).status).toBe(404);
    expect((await r.asContainer(repo, "dev", "/claims", claim("dev", "dev-all"), undefined, r.pub)).status).toBe(404);
  });

  test("claims survive a restart", async () => {
    const r = await deployed();
    const thread = { channel: "test", id: `${repo}#7` };
    await r.asContainer(repo, "docsbox", "/claims", { repo, container: "docsbox", workspace: "docs", thread });
    const again = await boot({ dir: r.dir });
    const event = comment(7);
    await again.webhook(event);
    await again.router.settled();
    expect(deliveryIds(r.docsbox)).toEqual([event.delivery!]);
  });

  test("untrusted, bot, unmatched and threadless events wake nothing", async () => {
    const r = await deployed();
    const drops = [
      comment(8, [], { actor: { login: "stranger", trusted: false, bot: false } }),
      comment(8, [], { actor: { login: "ci[bot]", trusted: true, bot: true } }),
      comment(8, [], { actor: undefined }),
      comment(8, [], { type: "issue.opened" }),
      comment(8, [], { thread: undefined }),
    ];
    for (const event of drops) expect(await (await r.webhook(event)).text()).toBe("no match");
    expect(await (await r.webhook({ type: "ping" })).text()).toBe("ignored");
    expect((await r.webhook(comment(8), "wrong-secret")).status).toBe(401);
    await r.router.settled();
    expect(r.dev.attempts + r.docsbox.attempts).toBe(0);
    expect(readdirSync(r.dir).includes("inbox") ? readdirSync(join(r.dir, "inbox")) : []).toEqual([]);
  });

  test("events on an undeployed repo wake nothing, and an undeployed repo stops receiving them", async () => {
    const r = await deployed();
    expect(await (await r.webhook(comment(9, [], { repo: "acme/other" }))).text()).toBe("no match");
    expect((await r.admin("DELETE", `/admin/repos/${repo}`)).status).toBe(204);
    expect(await (await r.webhook(comment(9))).text()).toBe("no match");
    await r.router.settled();
    expect(r.dev.attempts).toBe(0);
  });
});

describe("routing events to the deployer", () => {
  test("installation events reach the deployer even for undeployed repos", async () => {
    const deployer = fakeDeployer();
    const r = await boot({ deployer: deployer.url });
    const install = { delivery: "inst-1", type: "installation_repositories.added", repo: "acme/new" };
    expect((await r.webhook(install)).status).toBe(202);
    await r.router.settled();
    expect(deployer.events.map((e) => e.event.delivery)).toEqual(["inst-1"]);
  });

  test("only pushes to a deployed repo's default branch that touch .achq/ (or can't say) reach the deployer", async () => {
    const deployer = fakeDeployer();
    const r = await deployed({ deployer: deployer.url });
    const push = (delivery: string, detail: object, forRepo = repo) => ({ delivery, type: "push", repo: forRepo, detail: { defaultBranch: "main", ...detail } });
    await r.webhook(push("p-touch", { ref: "refs/heads/main", touchesConfig: true }));
    await r.webhook(push("p-truncated", { ref: "refs/heads/main", touchesConfig: false, truncated: true }));
    await r.webhook(push("p-untouched", { ref: "refs/heads/main", touchesConfig: false }));
    await r.webhook(push("p-branch", { ref: "refs/heads/feature", touchesConfig: true }));
    await r.webhook(push("p-undeployed", { ref: "refs/heads/main", touchesConfig: true }, "acme/other"));
    await r.router.settled();
    expect(deployer.events.map((e) => e.event.delivery).sort()).toEqual(["p-touch", "p-truncated"]);
    expect(r.dev.attempts).toBe(0);
  });
});

// ─── Persisted events ────────────────────────────────────────────────────────

describe("persisted events", () => {
  test("the delivery is on the volume before the router answers, and gone once delivered", async () => {
    const r = await deployed();
    const gate = hold(r.dev);
    const event = comment(10);
    const res = await r.webhook(event);
    expect(res.status).toBe(202);
    const file = join(r.dir, "inbox", `${event.delivery}.json`);
    // The container hasn't answered, and the delivery is already persisted.
    const stored = readJson(file);
    expect(stored.event.delivery).toBe(event.delivery!);
    expect(stored.commit).toBe("abc123");
    expect(stored.targets.map((t: any) => t.container)).toEqual(["dev"]);
    await gate.reached;
    gate.release();
    await r.router.settled();
    expect(existsSync(file)).toBe(false);
  });

  test("a router started on the same volume replays what's left in the inbox", async () => {
    const first = await deployed();
    const gate = hold(first.dev);
    const event = comment(11);
    await first.webhook(event);
    await gate.reached;
    // The first router is stuck mid-forward, as if it crashed. A new one starts on its volume.
    first.dev.respond = accepted;
    const second = await boot({ dir: first.dir });
    await second.router.settled();
    expect(deliveryIds(first.dev)).toEqual([event.delivery!, event.delivery!]);
    expect(existsSync(join(first.dir, "inbox", `${event.delivery}.json`))).toBe(false);
    gate.release();
    await first.router.settled();
  });

  test("a duplicate delivery ID isn't queued twice", async () => {
    const r = await deployed();
    const gate = hold(r.dev);
    const event = comment(12);
    expect(await (await r.webhook(event)).text()).toBe("accepted");
    expect(await (await r.webhook(event)).text()).toBe("duplicate");
    await gate.reached;
    gate.release();
    await r.router.settled();
    expect(deliveryIds(r.dev)).toEqual([event.delivery!]);
  });

  test("retries while a container wakes", async () => {
    const r = await deployed();
    let calls = 0;
    r.dev.respond = () => (++calls < 3 ? new Response("waking", { status: 502 }) : accepted());
    await r.webhook(comment(13));
    await r.router.settled();
    expect(r.dev.attempts).toBe(3);
    expect(existsSync(join(r.dir, "failed"))).toBe(false);
  });

  test("a target that runs out of retries lands in failed/ with the error, and leaves the inbox", async () => {
    const r = await deployed();
    r.dev.respond = () => new Response("down", { status: 503 });
    const event = comment(14);
    await r.webhook(event);
    await r.router.settled();
    expect(r.dev.attempts).toBe(3);
    const failed = readJson(join(r.dir, "failed", `${event.delivery}.json`));
    expect(failed.event.delivery).toBe(event.delivery!);
    expect(failed.targets[0].container).toBe("dev");
    expect(failed.targets[0].error).toContain("gave up after 3 attempts (503 down)");
    expect(existsSync(join(r.dir, "inbox", `${event.delivery}.json`))).toBe(false);
  });
});

// ─── Credentials ─────────────────────────────────────────────────────────────

describe("credentials", () => {
  const ask = (container: string) => ({ repo, container });

  test("a container gets credentials for its own policies, and one client credential per source", async () => {
    const r = await deployed();
    const res = await r.asContainer(repo, "dev", "/credentials", ask("dev"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CredentialsResponse;
    expect(body.credentials.map((c) => c.value)).toEqual(["token:code", "token:shared"]);
    expect(body.credentials.every((c) => c.scope.repo === repo)).toBe(true);
    // dev's two workspaces share a source: one client credential.
    expect(body.channels.map((c) => c.value)).toEqual([`client:app:${repo}`]);

    const docs = (await (await r.asContainer(repo, "docsbox", "/credentials", ask("docsbox"))).json()) as CredentialsResponse;
    expect(docs.credentials.map((c) => c.value)).toEqual(["token:docs-read"]);
  });

  test("a wrong secret, another repo's container, or an old timestamp is rejected", async () => {
    const r = await deployed();
    const other = fakeContainer("dev", "acme/gadgets");
    await r.admin("PUT", "/admin/repos/acme/gadgets", { ...config(other, other), repo: "acme/gadgets" });
    // docsbox's secret, asking as dev.
    expect((await r.asContainer(repo, "docsbox", "/credentials", ask("dev"))).status).toBe(401);
    // acme/gadgets' dev, asking for acme/widgets' dev.
    expect((await r.asContainer("acme/gadgets", "dev", "/credentials", ask("dev"))).status).toBe(401);
    // A captured request, replayed ten minutes later.
    expect((await r.asContainer(repo, "dev", "/credentials", ask("dev"), Date.now() - 10 * 60_000)).status).toBe(401);
    // Signed for /claims, sent to /credentials.
    const body = JSON.stringify(ask("dev"));
    const headers = signedHeaders(containerSecret(key, repo, "dev"), "POST", "/claims", body);
    expect((await fetch(`${r.priv}/credentials`, { method: "POST", body, headers })).status).toBe(401);
    // A container the repo doesn't have, with a genuine secret for that name.
    expect((await r.asContainer(repo, "ghost", "/credentials", ask("ghost"))).status).toBe(404);
  });

  test("the public port doesn't serve credentials", async () => {
    const r = await deployed();
    expect((await r.asContainer(repo, "dev", "/credentials", ask("dev"), undefined, r.pub)).status).toBe(404);
  });
});

// ─── Admin ───────────────────────────────────────────────────────────────────

describe("admin", () => {
  test("pushed router config survives a restart, and a delete does too", async () => {
    const r = await deployed();
    const again = await boot({ dir: r.dir });
    const repos = (await (await again.admin("GET", "/admin/repos", undefined, again.pub)).json()) as RouterRepoConfig[];
    expect(repos.map((c) => c.repo)).toEqual([repo]);
    // And routes on it.
    const event = comment(20);
    await again.webhook(event);
    await again.router.settled();
    expect(deliveryIds(r.dev)).toEqual([event.delivery!]);

    await again.admin("DELETE", `/admin/repos/${repo}`);
    const third = await boot({ dir: r.dir });
    expect(await (await third.admin("GET", "/admin/repos")).json()).toEqual([]);
  });

  test("admin requests need the admin signature, for this method and path", async () => {
    const r = await deployed();
    expect((await fetch(`${r.pub}/admin/repos`)).status).toBe(401);
    // Container secrets aren't admin.
    const path = "/admin/repos";
    expect((await fetch(`${r.priv}${path}`, { headers: signedHeaders(containerSecret(key, repo, "dev"), "GET", path, "") })).status).toBe(401);
    // A config for another repo than the path names.
    expect((await r.admin("PUT", "/admin/repos/acme/other", config(r.dev, r.docsbox))).status).toBe(400);
  });

  test("mint, validate, installations and sources", async () => {
    const r = await deployed();
    const minted = (await (await r.admin("POST", "/admin/mint", { repo, policies: [policy("deploy")] }, r.pub)).json()) as { value: string }[];
    expect(minted.map((c: any) => c.value)).toEqual(["token:deploy"]);
    const validated = await (await r.admin("POST", "/admin/validate", { repo, policies: [policy("ok"), { ...policy("bad"), ok: false }, { provider: "nope" }] })).json();
    expect(validated).toEqual({ problems: ["bad isn't allowed", 'No access provider "nope"'] });
    expect(await (await r.admin("GET", "/admin/installations")).json()).toEqual([{ provider: "test", source: "app", repo }]);
    expect(((await (await r.admin("GET", "/admin/sources")).json()) as { source: string }[])[0].source).toBe("app");
  });

  test("sync and status are forwarded to the deployer, waking it", async () => {
    const deployer = fakeDeployer();
    const r = await boot({ deployer: deployer.url });
    const sync = await r.admin("POST", "/admin/sync", { dryRun: true }, r.pub);
    expect(sync.status).toBe(200);
    expect(((await sync.json()) as { deployed: string[] }).deployed).toEqual([repo]);
    expect(deployer.syncs).toBe(2);
    expect(await (await r.admin("GET", "/admin/status")).json()).toEqual([{ repo, state: "deployed" }]);
  });
});

// ─── Wake ────────────────────────────────────────────────────────────────────

describe("wake", () => {
  test("rejects a missing token or one without push access, without waking anything", async () => {
    const r = await deployed({ github: fakeGitHub() });
    expect((await r.wake({ repo, container: "dev" })).status).toBe(401);
    expect((await r.wake({ repo, container: "dev" }, "read-token")).status).toBe(403);
    expect((await r.wake({ repo, container: "dev" }, "forged")).status).toBe(403);
    expect(r.dev.wakes).toBe(0);
  });

  test("wakes a deployed container, retrying until it answers", async () => {
    const r = await deployed({ github: fakeGitHub() });
    let calls = 0;
    r.dev.wakeRespond = () => (++calls < 3 ? new Response("starting", { status: 503 }) : new Response("ok"));
    const res = await r.wake({ repo, container: "dev" }, "push-token");
    expect([res.status, await res.text()]).toEqual([200, "awake"]);
    expect(r.dev.wakes).toBe(3);
    expect((await r.wake({ repo, container: "ghost" }, "push-token")).status).toBe(404);
  });

  test("answers 504 when the container never wakes", async () => {
    const r = await deployed({ github: fakeGitHub() });
    r.docsbox.wakeRespond = () => new Response("down", { status: 503 });
    expect((await r.wake({ repo, container: "docsbox" }, "push-token")).status).toBe(504);
  });
});

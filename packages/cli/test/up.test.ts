import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { achq, type SyncResult } from "@achq/core";
import { adminSecret, appWebhookSecret } from "@achq/core/secrets";
import { verifySigned } from "@achq/core/signing";
import * as github from "@achq/github";
import { RailwayClient } from "@achq/railway/api";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";
import * as railway from "@achq/railway";
import { checkInfra } from "../src/lib/load/infra.ts";
import { manifestFlow } from "../src/lib/manifest.ts";
import { type ExpanderDeps, infraExpanders } from "../src/lib/up/expanders.ts";
import { up, type UpDeps } from "../src/lib/up/up.ts";

const { privateKey: pem, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const pemBody = pem.split("\n")[5]; // a line from the middle of the key

const infra = () =>
  checkInfra(
    achq(() => {
      const router = new railway.Router("router", { project: "achq" });
      const deployer = new railway.Deployer("deployer", { project: "achq", router, owners: ["djgrant", "notationlabs"] });
      new github.App("personal", { name: "djgrant-claude", router, deployer });
    })(),
  );

let fake: FakeRailway;
let gh: ReturnType<typeof Bun.serve>;
let routerServer: ReturnType<typeof Bun.serve>;
let ghCalls: { method: string; path: string; body?: any; jwtOk: boolean }[];
let syncs: { body: any; signed: boolean }[];
let hook: { url?: string; content_type?: string; insecure_ssl?: string; secret?: string };
let appsCreated: number;
let tmp: string;
const realHome = process.env.HOME;
const realCwd = process.cwd();

/** The key the router runs with: its variable, with a reference to a shared variable resolved as Railway would. */
const routerKey = () => fake.service("achq-router")!.variables.AGENT_WEBHOOK_KEY!.replace(/\$\{\{shared\.(\w+)\}\}/, (_, name) => fake.project("achq")!.shared[name]!);

const jwtValid = (auth: string | null) => {
  const token = auth?.replace(/^Bearer /, "") ?? "";
  const [h, p, s] = token.split(".");
  return Boolean(s) && createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey(publicKey), s, "base64url");
};

beforeEach(() => {
  fake = startFakeRailway();
  ghCalls = [];
  syncs = [];
  hook = {};
  appsCreated = 0;
  gh = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "POST" && url.pathname.startsWith("/app-manifests") ? undefined : await req.json();
      ghCalls.push({ method: req.method, path: url.pathname, body, jwtOk: jwtValid(req.headers.get("authorization")) });
      if (req.method === "POST" && url.pathname === "/app-manifests/the-code/conversions") {
        appsCreated++;
        return Response.json({ id: 4242, slug: "djgrant-claude", pem, html_url: "https://github.com/apps/djgrant-claude" });
      }
      if (url.pathname === "/app/hook/config") {
        if (req.method === "PATCH") Object.assign(hook, body);
        return Response.json({ ...hook, secret: "********" });
      }
      if (url.pathname === "/app") return Response.json({ events: ["issues", "issue_comment", "push"], permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read", actions_variables: "write" } });
      return new Response("not found", { status: 404 });
    },
  });
  routerServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const signed = verifySigned(adminSecret(routerKey()), req.method, url.pathname, body, req.headers);
      syncs.push({ body: JSON.parse(body), signed });
      if (!signed) return new Response("bad signature", { status: 401 });
      const result: SyncResult = { deployed: ["djgrant/x"], unchanged: [], uninstalled: [], pruned: [], failed: [] };
      return Response.json(result);
    },
  });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "achq-up-"));
  process.env.HOME = tmp;
  process.chdir(tmp);
});

afterEach(() => {
  fake.stop();
  gh.stop(true);
  routerServer.stop(true);
  process.env.HOME = realHome;
  process.chdir(realCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const deps = (log: string[] = [], overrides: Partial<ExpanderDeps> = {}): UpDeps => ({
  expanders: infraExpanders({
    railway: new RailwayClient("t", fake.url),
    workspaceId: "ws",
    ref: "abc123",
    tokens: { railway: "railway-token", claude: "claude-token" },
    api: `http://localhost:${gh.port}`,
    publicBase: () => `http://localhost:${routerServer.port}`,
    sleep: async () => {},
    log: (line) => log.push(line),
    // The real manifest flow, with a "browser" that follows the page to GitHub and back.
    createApp: (request) =>
      manifestFlow(request, {
        githubApi: `http://localhost:${gh.port}`,
        open: async (page) => {
          const html = await (await fetch(page)).text();
          const state = html.match(/state=([0-9a-f]+)/)![1];
          const manifest = JSON.parse(html.match(/value='([^']*)'/)![1].replace(/&#39;/g, "'"));
          expect(manifest.hook_attributes).toEqual({ url: `http://localhost:${routerServer.port}/webhook`, active: true });
          expect(manifest.default_events).toEqual(["issues", "issue_comment", "push"]);
          expect(manifest.public).toBe(true);
          const res = await fetch(`${manifest.redirect_url}?code=the-code&state=${state}`);
          expect(res.ok).toBe(true);
        },
      }),
    ...overrides,
  }),
  log: (line) => log.push(line),
});

const scan = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return scan(p);
    return fs.readFileSync(p, "utf8").includes(pemBody) ? [p] : [];
  });

const rendered = async (service: string) => {
  const p = fake.project("achq")!;
  return new RailwayClient("t", fake.url).variables(p.id, p.environmentId, fake.service(service)!.id);
};

test("a dry run on nothing plans everything and changes nothing", async () => {
  const log: string[] = [];
  const result = await up(infra(), { prune: false, dryRun: true }, deps(log));
  expect(result).toBeUndefined();
  expect(fake.mutations).toEqual([]);
  expect(ghCalls).toEqual([]);
  expect(log).toEqual([
    "  + railway project achq",
    "  ? secret AGENT_WEBHOOK_KEY (after railway project achq)",
    "  ? service achq-router (after railway project achq)",
    "  ? achq-router private hostname (after railway project achq)",
    "  ? achq-router volume (after railway project achq)",
    "  ? achq-router public domains (after railway project achq)",
    "  ? achq-router variables (after railway project achq)",
    "  ? achq-router deploy (after railway project achq)",
    "  ? secret RAILWAY_API_TOKEN (after railway project achq)",
    "  ? secret CLAUDE_CODE_OAUTH_TOKEN (after railway project achq)",
    "  ? service achq-deployer (after railway project achq)",
    "  ? achq-deployer private hostname (after railway project achq)",
    "  ? achq-deployer volume (after railway project achq)",
    "  ? achq-deployer public domains (after railway project achq)",
    "  ? achq-deployer variables (after railway project achq)",
    "  ? achq-deployer deploy (after railway project achq)",
    "  ? github app djgrant-claude (after railway project achq)",
    "  sync: skipped until the router exists",
  ]);
});

test("up creates everything, keeps secrets only in shared variables that services refer to, and syncs signed", async () => {
  const result = await up(infra(), { prune: true, dryRun: false }, deps());
  expect(result?.deployed).toEqual(["djgrant/x"]);

  const shared = fake.project("achq")!.shared;
  const router = fake.service("achq-router")!;
  const deployer = fake.service("achq-deployer")!;
  const key = shared.AGENT_WEBHOOK_KEY!;
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.parse(shared.ACHQ_GITHUB_APP_DJGRANT_CLAUDE!)).toEqual({ slug: "djgrant-claude", id: "4242", privateKey: pem });
  expect(shared).toMatchObject({ RAILWAY_API_TOKEN: "railway-token", CLAUDE_CODE_OAUTH_TOKEN: "claude-token" });

  expect(router.variables).toMatchObject({
    AGENT_WEBHOOK_KEY: "${{shared.AGENT_WEBHOOK_KEY}}",
    ACHQ_GITHUB_APP_DJGRANT_CLAUDE: "${{shared.ACHQ_GITHUB_APP_DJGRANT_CLAUDE}}",
    ACHQ_DEPLOYER_URL: "http://achq-deployer.railway.internal:3000",
  });
  expect(await rendered("achq-router")).toMatchObject({ AGENT_WEBHOOK_KEY: key, ACHQ_GITHUB_APP_DJGRANT_CLAUDE: shared.ACHQ_GITHUB_APP_DJGRANT_CLAUDE });
  expect(router.domains).toHaveLength(1);
  expect(router.settings.sleepApplication).toBe(false);
  expect(deployer.domains).toEqual([]);
  expect(deployer.settings.sleepApplication).toBe(true);
  expect(deployer.variables).toMatchObject({
    AGENT_WEBHOOK_KEY: "${{shared.AGENT_WEBHOOK_KEY}}",
    ACHQ_ROUTER_URL: "http://achq-router.railway.internal:8081",
    ACHQ_ROUTER_PUBLIC_URL: `http://localhost:${routerServer.port}`,
    ACHQ_OWNERS: "djgrant,notationlabs",
    RAILWAY_API_TOKEN: "${{shared.RAILWAY_API_TOKEN}}",
    ACHQ_RAILWAY_PROJECT_ID: fake.project("achq")!.id,
    CLAUDE_CODE_OAUTH_TOKEN: "${{shared.CLAUDE_CODE_OAUTH_TOKEN}}",
    ACHQ_REF: "abc123",
  });
  // The App is created before the router's variables are set, so the router deploys once, with its credential.
  expect(router.deployments).toHaveLength(1);

  // The webhook secret was set after creation, as the App, from its ID.
  expect(hook).toMatchObject({ url: `http://localhost:${routerServer.port}/webhook`, content_type: "json", secret: appWebhookSecret(key, 4242) });
  expect(ghCalls.filter((c) => c.method === "PATCH").every((c) => c.jwtOk)).toBe(true);

  expect(syncs).toEqual([{ body: { prune: true, dryRun: false }, signed: true }]);

  // Positive control: the key is in Railway's (fake) state, and nowhere on disk.
  expect(JSON.stringify(fake.projects)).toContain(pemBody);
  expect(scan(tmp)).toEqual([]);
  expect(fs.existsSync(path.join(import.meta.dir, "../../../secrets.env")) ? fs.readFileSync(path.join(import.meta.dir, "../../../secrets.env"), "utf8") : "").not.toContain(pemBody);
});

test("a second up changes nothing, keeps the key, and fixes a webhook URL that drifted", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  const key = fake.project("achq")!.shared.AGENT_WEBHOOK_KEY;
  fake.mutations.length = 0;
  ghCalls = [];

  const log: string[] = [];
  await up(infra(), { prune: false, dryRun: false }, deps(log));
  expect(fake.mutations).toEqual([]);
  expect(ghCalls.map((c) => c.method)).not.toContain("PATCH");
  expect(fake.project("achq")!.shared.AGENT_WEBHOOK_KEY).toBe(key);
  expect(log).toEqual(["  up to date"]);

  hook.url = "https://old.example/webhook";
  const drift: string[] = [];
  await up(infra(), { prune: false, dryRun: true }, deps(drift));
  expect(drift).toEqual(["  ~ github app djgrant-claude hookUrl"]);
  expect(hook.url).toBe("https://old.example/webhook"); // dry run
  expect(syncs.at(-1)).toEqual({ body: { prune: false, dryRun: true }, signed: true });

  await up(infra(), { prune: false, dryRun: false }, deps());
  expect(hook.url).toBe(`http://localhost:${routerServer.port}/webhook`);
  expect(hook.secret).toBe(appWebhookSecret(key!, 4242));
});

test("a changed achq ref shows as variables and a new deploy, and a dry run applies none of it", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  fake.mutations.length = 0;
  const log: string[] = [];
  await up(infra(), { prune: false, dryRun: true }, deps(log, { ref: "def456" }));
  expect(log).toEqual(["  ~ achq-router variables ACHQ_REF", "  + achq-router deploy", "  ~ achq-deployer variables ACHQ_REF", "  + achq-deployer deploy"]);
  expect(fake.mutations).toEqual([]);
});

test("a new token from the environment replaces the kept one, and redeploys only what refers to it", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  const log: string[] = [];
  await up(infra(), { prune: false, dryRun: false }, deps(log, { tokens: { railway: "railway-token", claude: "new-claude-token" } }));
  expect(log).toEqual(["  ~ secret CLAUDE_CODE_OAUTH_TOKEN digest", "  + achq-deployer deploy"]);
  expect(fake.project("achq")!.shared.CLAUDE_CODE_OAUTH_TOKEN).toBe("new-claude-token");
  expect(fake.service("achq-deployer")!.deployments).toHaveLength(2);
  expect(fake.service("achq-router")!.deployments).toHaveLength(1);
});

test("secrets kept in the router's variables before shared variables existed are moved, not made again", async () => {
  // How an infra looked before: the key and each App's credential in the router's own variables.
  const client = new RailwayClient("t", fake.url);
  const project = await client.project(await client.createProject("achq", "ws"));
  const routerId = await client.createService(project.id, project.environmentId, "achq-router");
  await client.createDomain(project.environmentId, routerId, 8080);
  const oldKey = "a".repeat(64);
  await client.setVariables(project.id, project.environmentId, routerId, {
    AGENT_WEBHOOK_KEY: oldKey,
    ACHQ_GITHUB_APPS: JSON.stringify({ "djgrant-claude": { id: "4242", privateKey: pem } }),
  });
  Object.assign(hook, { url: `http://localhost:${routerServer.port}/webhook`, content_type: "json", insecure_ssl: "0", secret: appWebhookSecret(oldKey, 4242) });

  const plan: string[] = [];
  await up(infra(), { prune: false, dryRun: true }, deps(plan));
  expect(plan).toContain("  ~ secret AGENT_WEBHOOK_KEY location");
  expect(plan).toContain("  ~ github app djgrant-claude location");
  expect(plan.some((line) => line.includes("+ github app"))).toBe(false);
  expect(fake.project("achq")!.shared).toEqual({});

  await up(infra(), { prune: false, dryRun: false }, deps());
  const shared = fake.project("achq")!.shared;
  expect(shared.AGENT_WEBHOOK_KEY).toBe(oldKey);
  expect(JSON.parse(shared.ACHQ_GITHUB_APP_DJGRANT_CLAUDE!)).toEqual({ slug: "djgrant-claude", id: "4242", privateKey: pem });
  expect(appsCreated).toBe(0);
  expect(hook.secret).toBe(appWebhookSecret(oldKey, 4242));
  expect(fake.service("achq-router")!.variables.AGENT_WEBHOOK_KEY).toBe("${{shared.AGENT_WEBHOOK_KEY}}");
  expect(syncs.at(-1)?.signed).toBe(true);
});

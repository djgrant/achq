import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { achq } from "@achq/core";
import type { SyncResult } from "@achq/core";
import { adminSecret, appWebhookSecret, verifySigned } from "@achq/core/secrets";
import * as github from "@achq/github";
import { RailwayClient } from "@achq/railway";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";
import * as railway from "@achq/railway";
import { checkInfra, loadInfra } from "../src/lib/load.ts";
import { manifestFlow } from "../src/lib/manifest.ts";
import { up, type UpDeps } from "../src/lib/up.ts";

const { privateKey: pem, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const pemBody = pem.split("\n")[5]; // a line from the middle of the key

const infra = () =>
  checkInfra(
    achq(() => {
      const router = new railway.Router("router", { project: "achq" });
      const deployer = new railway.Deployer("deployer", { project: "achq", router, containerHost: railway.containerHost({ project: "achq" }), owners: ["djgrant", "notationlabs"] });
      new github.App("personal", { name: "djgrant-claude", router, deployer });
    })(),
  );

let fake: FakeRailway;
let gh: ReturnType<typeof Bun.serve>;
let routerServer: ReturnType<typeof Bun.serve>;
let ghCalls: { method: string; path: string; body?: any; jwtOk: boolean }[];
let syncs: { body: any; signed: boolean }[];
let hook: { url?: string; content_type?: string; insecure_ssl?: string; secret?: string };
let tmp: string;
const realHome = process.env.HOME;
const realCwd = process.cwd();

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
  gh = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "POST" && url.pathname.startsWith("/app-manifests") ? undefined : await req.json();
      ghCalls.push({ method: req.method, path: url.pathname, body, jwtOk: jwtValid(req.headers.get("authorization")) });
      if (req.method === "POST" && url.pathname === "/app-manifests/the-code/conversions") {
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
      const routerVars = fake.service("achq-router")!.variables;
      const signed = verifySigned(adminSecret(routerVars.AGENT_WEBHOOK_KEY), req.method, url.pathname, body, req.headers);
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

const deps = (log: string[] = []): UpDeps => ({
  railway: new RailwayClient("t", fake.url),
  railwayToken: "railway-token",
  claudeToken: "claude-token",
  workspaceId: "ws",
  achqRef: async () => "abc123",
  githubApi: `http://localhost:${gh.port}`,
  routerBase: () => `http://localhost:${routerServer.port}`,
  log: (line) => log.push(line),
  sleep: async () => {},
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
});

const scan = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return scan(p);
    return fs.readFileSync(p, "utf8").includes(pemBody) ? [p] : [];
  });

test("a dry run on nothing plans everything and changes nothing", async () => {
  const log: string[] = [];
  const result = await up(infra(), { prune: false, dryRun: true }, deps(log));
  expect(result).toBeUndefined();
  expect(fake.mutations).toEqual([]);
  expect(ghCalls).toEqual([]);
  expect(log).toEqual([
    "  + railway project achq",
    "  + service achq-router",
    "  + achq-router volume /data",
    "  + achq-router public domain → :8080",
    "  ~ achq-router deploy",
    "  + service achq-deployer",
    "  + achq-deployer volume /data",
    "  ~ achq-deployer deploy",
    "  + github app djgrant-claude: opens GitHub to create it",
    "  sync: skipped until the router exists",
  ]);
});

test("up creates everything, puts the App's key only in the router's variables, and syncs signed", async () => {
  const result = await up(infra(), { prune: true, dryRun: false }, deps());
  expect(result?.deployed).toEqual(["djgrant/x"]);

  const router = fake.service("achq-router")!;
  const deployer = fake.service("achq-deployer")!;
  const key = router.variables.AGENT_WEBHOOK_KEY;
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.parse(router.variables.ACHQ_GITHUB_APPS)).toEqual({ "djgrant-claude": { id: "4242", privateKey: pem } });
  expect(router.variables.ACHQ_DEPLOYER_URL).toBe("http://achq-deployer.railway.internal:3000");
  expect(router.domains).toHaveLength(1);
  expect(router.settings.sleepApplication).toBe(false);
  expect(deployer.domains).toEqual([]);
  expect(deployer.settings.sleepApplication).toBe(true);
  expect(deployer.variables).toMatchObject({
    AGENT_WEBHOOK_KEY: key,
    ACHQ_ROUTER_URL: "http://achq-router.railway.internal:8081",
    ACHQ_OWNERS: "djgrant,notationlabs",
    RAILWAY_API_TOKEN: "railway-token",
    ACHQ_RAILWAY_PROJECT_ID: fake.project("achq")!.id,
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
    ACHQ_REF: "abc123",
  });
  // The router deployed again with the new key.
  expect(router.deployments).toHaveLength(2);

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
  const key = fake.service("achq-router")!.variables.AGENT_WEBHOOK_KEY;
  fake.mutations.length = 0;
  ghCalls = [];

  const log: string[] = [];
  await up(infra(), { prune: false, dryRun: false }, deps(log));
  expect(fake.mutations).toEqual([]);
  expect(ghCalls.map((c) => c.method)).not.toContain("PATCH");
  expect(fake.service("achq-router")!.variables.AGENT_WEBHOOK_KEY).toBe(key);
  expect(log).toEqual(["  achq-router: up to date", "  achq-deployer: up to date", "  djgrant-claude: up to date"]);

  hook.url = "https://old.example/webhook";
  const drift: string[] = [];
  await up(infra(), { prune: false, dryRun: true }, deps(drift));
  expect(drift).toContain(`  ~ djgrant-claude webhook → http://localhost:${routerServer.port}/webhook`);
  expect(hook.url).toBe("https://old.example/webhook"); // dry run
  expect(syncs.at(-1)).toEqual({ body: { prune: false, dryRun: true }, signed: true });

  await up(infra(), { prune: false, dryRun: false }, deps());
  expect(hook.url).toBe(`http://localhost:${routerServer.port}/webhook`);
  expect(hook.secret).toBe(appWebhookSecret(key, 4242));
});

test("a changed achq ref shows as variables and a deploy, and a dry run applies none of it", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  fake.mutations.length = 0;
  const log: string[] = [];
  await up(infra(), { prune: false, dryRun: true }, { ...deps(log), achqRef: async () => "def456" });
  expect(log.slice(0, 4)).toEqual(["  ~ achq-router variables ACHQ_REF", "  ~ achq-router deploy", "  ~ achq-deployer variables ACHQ_REF", "  ~ achq-deployer deploy"]);
  expect(fake.mutations).toEqual([]);
});

test("the infra must keep the router, deployer and containers in one project", () => {
  expect(() =>
    checkInfra(
      achq(() => {
        const router = new railway.Router("router", { project: "achq" });
        new railway.Deployer("deployer", { project: "achq", router, containerHost: railway.containerHost({ project: "other" }), owners: [] });
      })(),
    ),
  ).toThrow("share one Railway project");
});

test("an achq.infra.ts file, written as the design shows, loads with its imports resolved to achq", async () => {
  fs.writeFileSync(
    path.join(tmp, "achq.infra.ts"),
    `import { achq } from "achq";
import * as github from "achq/github";
import * as railway from "achq/railway";

export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  const deployer = new railway.Deployer("deployer", {
    project: "achq",
    router,
    containerHost: railway.containerHost({ project: "achq" }),
    owners: ["djgrant", "notationlabs"],
  });
  new github.App("personal", { name: "djgrant-claude", router, deployer });
  new github.App("notation", { name: "notation-achq", org: "notationlabs", router, deployer });
});
`,
  );
  const loaded = await loadInfra(path.join(tmp, "achq.infra.ts"));
  expect(loaded.project).toBe("achq");
  expect(loaded.deployer.inputs.owners).toEqual(["djgrant", "notationlabs"]);
  expect(loaded.apps.map((a) => [a.inputs.name, a.inputs.org])).toEqual([["djgrant-claude", undefined], ["notation-achq", "notationlabs"]]);
});

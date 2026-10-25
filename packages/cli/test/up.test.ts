import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { achq, type SyncRequest, type SyncResult } from "@achq/core";
import { context } from "@achq/core/context";
import { adminSecret, implementationSecret } from "@achq/core/secrets";
import { verifySigned } from "@achq/core/signing";
import * as github from "@achq/github/infra";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";
import * as railway from "@achq/railway/infra";
import { fakeOp } from "@achq/test-utils/op";
import { checkInfra, configVault, down, type DownDeps, routerAccess, up, type UpDeps } from "../src/lib/infra.ts";

const { privateKey: pem, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const pemBody = pem.split("\n")[5]; // a line from the middle of the key

/** GitHub's webhook secret for an App: github's label under the router's key. */
const appWebhookSecret = (key: string, appId: string | number) => implementationSecret(key, `github-app-webhook:${appId}`);

const infra = () =>
  checkInfra(
    achq(() => {
      const router = new railway.Router("router", { project: "achq" });
      new railway.Deployer("deployer", { router, owners: ["djgrant", "notationlabs"] });
      new github.Channel("personal", { name: "djgrant-claude", router });
    })(),
  );

/** The router's public URL on the fake Railway. Its webhooks go there; the sync goes to `routerServer`. */
const ROUTER_URL = "https://achq-router-production.up.railway.app";

let fake: FakeRailway;
let gh: ReturnType<typeof Bun.serve>;
let routerServer: ReturnType<typeof Bun.serve>;
let ghCalls: { method: string; path: string; body?: any; jwtOk: boolean }[];
let syncs: { body: any; signed: boolean }[];
/** Each sync to no repos the deployer was asked for, as `achq infra down` asks, and how many Railway projects there were then. */
let downs: { request: SyncRequest; projects: number }[];
/** How many times the deployer answers a sync's ID as one it's lost, restarting. */
let lost = 0;
/** How many times the deployer answers a sync's ID as one it was running when it stopped. */
let interrupted = 0;
let last: SyncRequest | undefined;
let polls = 0;
/** How many times the deployer answers as one too old to say what it runs. */
let oldDeployer = 0;
let hook: { url?: string; content_type?: string; insecure_ssl?: string; secret?: string };
let tmp: string;
let secrets = 0;
// Distinct per call, so a key made again on apply would show.
const newSecret = () => (++secrets).toString(16).padStart(64, "0");
const realHome = process.env.HOME;
const realCwd = process.cwd();

const jwtValid = (auth: string | null) => {
  const token = auth?.replace(/^bearer /i, "") ?? "";
  const [h, p, s] = token.split(".");
  return Boolean(s) && createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey(publicKey), s, "base64url");
};

beforeEach(() => {
  fake = startFakeRailway();
  ghCalls = [];
  syncs = [];
  downs = [];
  lost = 0;
  interrupted = 0;
  last = undefined;
  oldDeployer = 0;
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
      if (!signed) return new Response("bad signature", { status: 401 });
      // The deployer runs what the router was given, as a new one does once it's replaced the old.
      if (url.pathname === "/admin/deployer") return oldDeployer-- > 0 ? new Response("not found", { status: 404 }) : Response.json({ ref: routerVars.ACHQ_REF });
      // A sync starts, then is asked after: running once, then done.
      if (req.method === "POST") {
        const request = JSON.parse(body) as SyncRequest;
        last = request;
        if (request.empty) downs.push({ request, projects: fake.projects.length });
        else syncs.push({ body: request, signed });
        polls = 0;
        return Response.json({ id: "sync-1" }, { status: 202 });
      }
      if (url.pathname !== "/admin/sync/sync-1" || lost-- > 0) return new Response("not found", { status: 404 });
      if (interrupted-- > 0) return Response.json({ state: "interrupted" });
      // One to no repos uninstalls the one there is, and deletes its container.
      const result: SyncResult = last?.empty
        ? { deployed: [], unchanged: [], uninstalled: ["djgrant/x"], pruned: ["djgrant/x/dev"], failed: [] }
        : { deployed: ["djgrant/x"], unchanged: [], uninstalled: [], pruned: [], failed: [] };
      return Response.json(++polls < 2 ? { state: "running" } : { state: "done", result });
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
  env: {
    RAILWAY_API_TOKEN: "railway-token",
    RAILWAY_API_URL: fake.url,
    RAILWAY_WORKSPACE_ID: "ws",
    GITHUB_API_URL: `http://localhost:${gh.port}`,
    GITHUB_WEB_URL: `http://localhost:${gh.port}`,
  },
  newSecret,
  sleep: async () => {},
  containerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "claude-token" },
  achqRef: async () => "abc123",
  routerUrl: () => `http://localhost:${routerServer.port}`,
  log: (line) => log.push(line),
  // The real manifest flow, with a "browser" that follows the page to GitHub and back.
  open: async (page, what) => {
    expect(what).toBe("create djgrant-claude on GitHub");
    const html = await (await fetch(page)).text();
    expect(html).toContain(`action="http://localhost:${gh.port}/settings/apps/new?state=`);
    const state = html.match(/state=([0-9a-f]+)/)![1];
    const manifest = JSON.parse(html.match(/value='([^']*)'/)![1].replace(/&#39;/g, "'"));
    expect(manifest.hook_attributes).toEqual({ url: `${ROUTER_URL}/webhook`, active: true });
    expect(manifest.default_events).toEqual(["issues", "issue_comment", "push"]);
    expect(manifest.public).toBe(true);
    const res = await fetch(`${manifest.redirect_url}?code=the-code&state=${state}`);
    expect(res.ok).toBe(true);
  },
});

/** What `achq infra up` plans for an infra that doesn't exist yet. */
const FRESH = [
  "  + achq            railway project",
  "  + achq-router     service",
  "  + achq-router     volume           /data",
  "  + achq-router     public domain    → :8080",
  "  ~ achq-router     variables        7",
  "  + djgrant-claude  github channel   opens GitHub to create its App",
  "  ~ achq-router     deploy",
  "  + achq-deployer   service",
  "  + achq-deployer   volume           /data",
  "  ~ achq-deployer   variables        12",
  "  ~ achq-deployer   deploy",
];

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
    ...FRESH,
    "  sync: skipped until the router exists",
  ]);
});

test("up creates everything, puts the App's key only in the router's variables, and syncs signed", async () => {
  const log: string[] = [];
  const result = await up(infra(), { prune: true, dryRun: false }, deps(log));
  expect(result?.deployed).toEqual(["djgrant/x"]);
  // Planned and applied in one pass: the App is made between the router's service and its deploy.
  expect(log).toEqual([...FRESH, "  created https://github.com/apps/djgrant-claude", "  waiting for the router to deploy…"]);

  const router = fake.service("achq-router")!;
  const deployer = fake.service("achq-deployer")!;
  const key = router.variables.AGENT_WEBHOOK_KEY;
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.parse(router.variables.ACHQ_GITHUB_APPS)).toEqual({ "djgrant-claude": { id: "4242", privateKey: pem } });
  expect(router.variables.ACHQ_DEPLOYER_URL).toBe("http://achq-deployer.railway.internal:3000");
  // Its store is its container provider's.
  expect(router.variables.ACHQ_CONTAINER_PROVIDER).toBe("railway");
  expect(router.domains).toHaveLength(1);
  expect(router.settings.sleepApplication).toBe(false);
  expect(deployer.domains).toEqual([]);
  expect(deployer.settings.sleepApplication).toBe(true);
  expect(deployer.variables).toMatchObject({
    AGENT_WEBHOOK_KEY: key,
    ACHQ_ROUTER_URL: "http://achq-router.railway.internal:8081",
    ACHQ_OWNERS: "djgrant,notationlabs",
    RAILWAY_API_TOKEN: "railway-token",
    ACHQ_ROUTER_PUBLIC_URL: ROUTER_URL,
    ACHQ_CONTAINER_PROVIDER: "railway",
    ACHQ_RAILWAY_PROJECT_ID: fake.project("achq")!.id,
    ACHQ_CONTAINER_ENV: JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "claude-token" }),
    ACHQ_REF: "abc123",
  });
  // One graph: the router deploys once, with the App's key already in its variables.
  expect(router.deployments).toHaveLength(1);

  // The webhook secret was set after creation, as the App, from its ID.
  expect(hook).toMatchObject({ url: `${ROUTER_URL}/webhook`, content_type: "json", secret: appWebhookSecret(key, 4242) });
  expect(ghCalls.filter((c) => c.method === "PATCH").every((c) => c.jwtOk)).toBe(true);

  expect(syncs).toEqual([{ body: { prune: true, dryRun: false }, signed: true }]);

  // Positive control: the key is in Railway's (fake) state, and nowhere on disk.
  expect(JSON.stringify(fake.projects)).toContain(pemBody);
  expect(scan(tmp)).toEqual([]);
  expect(fs.existsSync(path.join(import.meta.dir, "../../../secrets.env")) ? fs.readFileSync(path.join(import.meta.dir, "../../../secrets.env"), "utf8") : "").not.toContain(pemBody);
});

/** The pages `down` opened. */
let opened: string[] = [];

const downDeps = (log: string[], answer: boolean): DownDeps => {
  const { env, sleep, routerUrl } = deps();
  opened = [];
  return { env, sleep, routerUrl, log: (line) => log.push(line), confirm: async () => answer, open: async (url) => void opened.push(url) };
};

test("down shows what it deletes, the deployer's sync to no repos first, and what's protected; a dry run or a no deletes nothing", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  const log: string[] = [];
  await down(infra(), { dryRun: true }, downDeps(log, true));
  expect(log).toEqual([
    "  sync: would uninstall: djgrant/x",
    "  sync: would prune: djgrant/x/dev",
    "  - router/project  railway-project",
    "    personal        github-channel   protected",
  ]);
  await expect(down(infra(), { dryRun: false }, downDeps([], false))).rejects.toThrow("Nothing was deleted");
  expect(downs.map((d) => d.request.dryRun)).toEqual([true, true]);
  expect(opened).toEqual([]);
  expect(fake.projects).toHaveLength(1);
});

test("down has the deployer delete what it showed, then deletes the infra; then there's nothing left to delete", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  const log: string[] = [];
  await down(infra(), { dryRun: false }, downDeps(log, true));
  expect(downs).toEqual([
    { request: { empty: true, prune: true, dryRun: true }, projects: 1 },
    { request: { empty: true, prune: true, expect: ["djgrant/x/dev"] }, projects: 1 },
  ]);
  expect(fake.projects).toEqual([]);
  expect(log.slice(-3)).toEqual(["  sync: uninstalled: djgrant/x", "  sync: pruned: djgrant/x/dev", "  deleted"]);
  // Where you delete the App yourself.
  expect(opened).toEqual([`http://localhost:${gh.port}/settings/apps/djgrant-claude/advanced`]);

  // With no router, there's no deployer to ask.
  const again: string[] = [];
  await down(infra(), { dryRun: false }, downDeps(again, true));
  expect(again).toEqual(["  nothing to delete"]);
  expect(opened).toEqual([]);
  expect(downs).toHaveLength(2);
});

test("a sync the deployer lost, restarting, is started again", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  lost = 1;
  expect((await up(infra(), { prune: false, dryRun: false }, deps()))?.deployed).toEqual(["djgrant/x"]);
  expect(syncs).toHaveLength(3);
});

test("a sync interrupted by its deployer stopping is started again", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  interrupted = 1;
  expect((await up(infra(), { prune: false, dryRun: false }, deps()))?.deployed).toEqual(["djgrant/x"]);
  expect(syncs).toHaveLength(3);
});

test("up waits for the new deployer to replace the old before it syncs", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  oldDeployer = 2;
  const log: string[] = [];
  expect((await up(infra(), { prune: false, dryRun: false }, deps(log)))?.deployed).toEqual(["djgrant/x"]);
  expect(log).toContain("  waiting for the deployer to run abc123…");
  expect(oldDeployer).toBe(-1);
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
  expect(log).toEqual(["  up to date"]);

  hook.url = "https://old.example/webhook";
  const drift: string[] = [];
  await up(infra(), { prune: false, dryRun: true }, deps(drift));
  expect(drift).toContain(`  ~ djgrant-claude  webhook  → ${ROUTER_URL}/webhook`);
  expect(hook.url).toBe("https://old.example/webhook"); // dry run
  expect(syncs.at(-1)).toEqual({ body: { prune: false, dryRun: true }, signed: true });

  await up(infra(), { prune: false, dryRun: false }, deps());
  expect(hook.url).toBe(`${ROUTER_URL}/webhook`);
  expect(hook.secret).toBe(appWebhookSecret(key, 4242));
});

test("a changed achq ref shows as variables and a deploy, and a dry run applies none of it", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  fake.mutations.length = 0;
  const log: string[] = [];
  await up(infra(), { prune: false, dryRun: true }, { ...deps(log), achqRef: async () => "def456" });
  expect(log.slice(0, 4)).toEqual(["  ~ achq-router    variables  1", "  ~ achq-router    deploy", "  ~ achq-deployer  variables  1", "  ~ achq-deployer  deploy"]);
  expect(fake.mutations).toEqual([]);
});

test("`achq infra status` finds the router's URL and key by planning it, and changes nothing", async () => {
  const ctx = () => context({ env: deps().env });
  await expect(routerAccess(infra(), ctx())).rejects.toThrow("There's no router router. Run `achq infra up`.");
  await up(infra(), { prune: false, dryRun: false }, deps());
  fake.mutations.length = 0;
  expect(await routerAccess(infra(), ctx())).toEqual({ url: ROUTER_URL, key: fake.service("achq-router")!.variables.AGENT_WEBHOOK_KEY });
  expect(fake.mutations).toEqual([]);
});

test("with a vault, a new App's key is kept in it too, and a new router gets it from there without making the App again", async () => {
  const op = fakeOp();
  try {
    const vault = configVault({ vault: { provider: "1password", name: "Infra" } }, { ACHQ_1PASSWORD_OP: op.bin });
    await up(infra(), { prune: false, dryRun: false }, { ...deps(), vault });
    const [item] = op.items();
    expect(item).toMatchObject({ vault: "Infra", title: "GitHub App djgrant-claude", archived: false });
    expect(Object.fromEntries(item!.fields.map((f) => [f.label, f.value]))).toEqual({ app_id: "4242", private_key: pem });
    // Nothing on op's command line, or on disk, has the key.
    expect(JSON.stringify(op.calls())).not.toContain(pemBody);
    expect(scan(tmp)).toEqual([]);

    // Another router, as on a new account.
    fake.stop();
    fake = startFakeRailway();
    hook.secret = "the old router's";
    const log: string[] = [];
    const noBrowser = async () => {
      throw new Error("the App shouldn't be made again");
    };
    await up(infra(), { prune: false, dryRun: false }, { ...deps(log), open: noBrowser, vault });
    expect(log).toContain("  ~ djgrant-claude  app key          from the vault, and its webhook to this router");
    const router = fake.service("achq-router")!;
    expect(JSON.parse(router.variables.ACHQ_GITHUB_APPS)).toEqual({ "djgrant-claude": { id: "4242", privateKey: pem } });
    expect(hook.secret).toBe(appWebhookSecret(router.variables.AGENT_WEBHOOK_KEY, 4242));
    expect(ghCalls.filter((c) => c.path.startsWith("/app-manifests"))).toHaveLength(1);
  } finally {
    op.stop();
  }
});

test("--rotate-deployer-token asks the deployer to replace its token, and isn't part of the sync", async () => {
  const resources = infra();
  let rotated = 0;
  resources.deployer.rotateToken = () => void rotated++;
  await up(resources, { prune: false, dryRun: false, rotateDeployerToken: true }, deps());
  expect(rotated).toBe(1);
  expect(syncs.at(-1)!.body).toEqual({ prune: false, dryRun: false });
});

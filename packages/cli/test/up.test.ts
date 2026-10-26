import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { achq, CORE_PLUGIN } from "@achq/core";
import type { SyncRequest, SyncResult } from "@achq/core/protocol";
import { adminSecret, implementationSecret } from "@achq/core/secrets";
import { routerAdminRoutes } from "@achq/core/routes/router-admin";
import { verifySigned } from "@achq/core/signing";
import * as claude from "@achq/claude/infra";
import * as github from "@achq/github/infra";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/fakes/vendors/railway";
import * as railway from "@achq/railway/infra";
import { fakeOp } from "@achq/test-utils/fakes/vendors/1password";
import { serve } from "@achq/utils/routes";
import { Hono } from "hono";
import type { z } from "zod";
import * as onepassword from "@achq/1password";
import { infraApply } from "../tasks/infra.apply.ts";
import { infraFindRouter } from "../tasks/infra.find-router.ts";
import { checkInfra, type InfraResources } from "../tasks/infra.load.ts";
import { infraTearDown } from "../tasks/infra.tear-down.ts";
import { run } from "../tasks/run.ts";
import { testRunner } from "./runner.ts";

/** What a task takes, as its caller passes it. */
type Params<T extends { params?: z.ZodType }> = z.input<NonNullable<T["params"]>>;
type UpDeps = Omit<Params<typeof infraApply>, "infra" | "prune" | "dryRun" | "rotateDeployerToken">;
type DownDeps = Omit<Params<typeof infraTearDown>, "infra" | "dryRun">;

/** `achq infra up`'s task, run through pok with what the command gets from your shell and terminal as params. */
const up = async (infra: InfraResources, options: { prune: boolean; dryRun: boolean; rotateDeployerToken?: boolean }, deps: UpDeps) => run(testRunner(), infraApply, { infra, ...options, ...deps });

/** `achq infra down`'s. */
const down = async (infra: InfraResources, { dryRun }: { dryRun: boolean }, deps: DownDeps) => run(testRunner(), infraTearDown, { infra, dryRun, ...deps });

const { privateKey: pem, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const pemBody = pem.split("\n")[5]; // a line from the middle of the key

/** GitHub's webhook secret for an App: github's label under the router's key. */
const appWebhookSecret = (key: string, appId: string | number) => implementationSecret(key, `github-app-webhook:${appId}`);

/** The plugins the infra's resources come from, as this checkout's packages are versioned. */
// Releases are lockstep, so each plugin is at core's version.
const RAILWAY = { package: "@achq/railway", version: CORE_PLUGIN.version };
const GITHUB = { package: "@achq/github", version: CORE_PLUGIN.version };
const CLAUDE = { package: "@achq/claude", version: CORE_PLUGIN.version };

const infra = () =>
  checkInfra(
    achq(() => {
      const router = new railway.Router("router", { project: "achq" });
      new railway.Deployer("deployer", { router, owners: ["djgrant", "notationlabs"] });
      new github.Channel("personal", { name: "djgrant-claude", router });
      new github.CodeHost("github");
      new claude.AgentRuntime("claude");
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
/** How many times the deployer answers a sync's ID as one it was running when it stopped. */
let interrupted = 0;
let last: SyncRequest | undefined;
let polls = 0;
/** How many times the deployer, being replaced, doesn't answer, then answers as the old one. */
let replacing = 0;
let hook: { url?: string; content_type?: string; insecure_ssl?: string; secret?: string };
let tmp: string;
let secrets = 0;
/** Each package `achq infra up` looked up on npm. */
let published: string[] = [];
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
  published = [];
  ghCalls = [];
  syncs = [];
  downs = [];
  interrupted = 0;
  last = undefined;
  replacing = 0;
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
  // The router's admin routes the sync takes, as `@achq/core/routes/router-admin` declares them, forwarding to the deployer it fakes.
  const admin = new Hono();
  admin.use(async (c, next) => {
    const routerVars = fake.service("achq-router")!.variables;
    const signed = verifySigned(adminSecret(routerVars.AGENT_WEBHOOK_KEY), c.req.method, new URL(c.req.url).pathname, await c.req.text(), c.req.raw.headers);
    if (!signed) return c.text("bad signature", 401);
    await next();
  });
  // The deployer runs what the router was given, as a new one does once it's replaced the old.
  serve(admin, routerAdminRoutes.deployerVersion, (c) =>
    replacing-- > 0
      ? replacing % 2
        ? c.text("the deployer didn't answer", 504)
        : c.json({ version: "0.0.1", plugins: [] }, 200)
      : c.json({ version: CORE_PLUGIN.version, plugins: JSON.parse(fake.service("achq-router")!.variables.ACHQ_PLUGINS!) }, 200),
  );
  // A sync starts, then is asked after: running once, then done.
  serve(admin, routerAdminRoutes.sync, (c) => {
    const request = c.req.valid("json");
    last = request;
    if (request.empty) downs.push({ request, projects: fake.projects.length });
    else syncs.push({ body: request, signed: true });
    polls = 0;
    return c.json({ id: "sync-1" }, 202);
  });
  serve(admin, routerAdminRoutes.syncStatus, (c) => {
    if (c.req.valid("param").id !== "sync-1") return c.text("no such sync", 404);
    if (interrupted-- > 0) return c.json({ state: "interrupted" as const }, 200);
    // One to no repos uninstalls the one there is, and deletes its container.
    const result: SyncResult = last?.empty
      ? { deployed: [], unchanged: [], uninstalled: ["djgrant/x"], pruned: ["djgrant/x/dev"], failed: [] }
      : { deployed: ["djgrant/x"], unchanged: [], uninstalled: [], pruned: [], failed: [] };
    return c.json(++polls < 2 ? { state: "running" as const } : { state: "done" as const, result }, 200);
  });
  routerServer = Bun.serve({ port: 0, fetch: new Hono().route("/admin", admin).fetch });
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
  // Railway and GitHub ask for no secret at the terminal.
  prompt: async () => {
    throw new Error("nothing asks for a secret");
  },
  containerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "claude-token" },
  // Every package is on npm, and takes this core.
  npm: async (pkg) => {
    published.push(pkg);
    return { peerDependencies: { "@achq/core": `^${CORE_PLUGIN.version}` } };
  },
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
  "  ~ achq-deployer   variables        13",
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
    // Every container loads the channel's plugin and the runtime's.
    ACHQ_CONTAINER_ENV: JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "claude-token", ACHQ_PLUGINS: JSON.stringify([GITHUB, CLAUDE]) }),
    ACHQ_AGENT_RUNTIMES: "claude",
    ACHQ_PLUGINS: JSON.stringify([RAILWAY, GITHUB]),
  });
  // The router runs on Railway, and is the channel's and code host's.
  expect(router.variables.ACHQ_PLUGINS).toBe(JSON.stringify([RAILWAY, GITHUB]));
  expect(router.settings.startCommand).toBe(`env BUN_INSTALL_CACHE_DIR=/data/bun-cache bunx @achq/router@${CORE_PLUGIN.version}`);
  // Each was checked on npm first, with the services and runner at core's version.
  expect(published.sort()).toEqual(["@achq/claude", "@achq/deployer", "@achq/github", "@achq/railway", "@achq/router", "@achq/runner"]);
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

test("a sync interrupted by its deployer stopping is started again", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  interrupted = 1;
  expect((await up(infra(), { prune: false, dryRun: false }, deps()))?.deployed).toEqual(["djgrant/x"]);
  expect(syncs).toHaveLength(3);
});

test("up waits for the new deployer to replace the old before it syncs", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  replacing = 2;
  const log: string[] = [];
  expect((await up(infra(), { prune: false, dryRun: false }, deps(log)))?.deployed).toEqual(["djgrant/x"]);
  expect(log).toContain(`  waiting for the deployer to run @achq/deployer@${CORE_PLUGIN.version}, @achq/railway@${RAILWAY.version}, @achq/github@${GITHUB.version}…`);
  expect(replacing).toBe(-1);
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

test("a plugin at another version shows as variables and a deploy, and a dry run applies none of it", async () => {
  await up(infra(), { prune: false, dryRun: false }, deps());
  fake.mutations.length = 0;
  const log: string[] = [];
  // As if the infra repo had installed another version of the GitHub plugin.
  const bumped = infra();
  for (const r of bumped.resources) if (r.plugin.package === "@achq/github") Object.assign(r, { plugin: { ...r.plugin, version: "0.1.1" } });
  await up(bumped, { prune: false, dryRun: true }, deps(log));
  expect(log.slice(0, 4)).toEqual(["  ~ achq-router    variables  1", "  ~ achq-router    deploy", "  ~ achq-deployer  variables  2", "  ~ achq-deployer  deploy"]);
  expect(fake.mutations).toEqual([]);
});

test("a plugin that isn't on npm, or doesn't take the services' core, stops up before anything is planned", async () => {
  const log: string[] = [];
  const npm = async (pkg: string) => (pkg === "@achq/claude" ? undefined : { peerDependencies: { "@achq/core": pkg === "@achq/github" ? "^9.0.0" : `^${CORE_PLUGIN.version}` } });
  await expect(up(infra(), { prune: false, dryRun: true }, { ...deps(log), npm })).rejects.toThrow(
    `The infra's plugins can't be installed:\n  @achq/github@${GITHUB.version} needs @achq/core@^9.0.0, but the services run ${CORE_PLUGIN.version}\n  @achq/claude@${CLAUDE.version} isn't on npm`,
  );
  expect(log).toEqual([]);
  expect(fake.mutations).toEqual([]);
});

test("`achq infra status` finds the router's URL and key by planning it, and changes nothing", async () => {
  const routerAccess = async (infra: InfraResources) => run(testRunner(), infraFindRouter, { infra, env: deps().env });
  await expect(routerAccess(infra())).rejects.toThrow("There's no router router. Run `achq infra up`.");
  await up(infra(), { prune: false, dryRun: false }, deps());
  fake.mutations.length = 0;
  expect(await routerAccess(infra())).toEqual({ url: ROUTER_URL, key: fake.service("achq-router")!.variables.AGENT_WEBHOOK_KEY });
  expect(fake.mutations).toEqual([]);
});

test("with a vault, a new App's key is kept in it too, and a new router gets it from there without making the App again", async () => {
  const op = fakeOp();
  try {
    // As achq.config.ts gives it, with `op` found once it's used.
    process.env.ACHQ_1PASSWORD_OP = op.bin;
    const vault = onepassword.vault("Infra");
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
    delete process.env.ACHQ_1PASSWORD_OP;
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

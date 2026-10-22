import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as core from "@achq/core";
import { achq, type Change, type Context, type Output, plan } from "@achq/core";
import { type FakeCloudflare, fakeWrangler, startFakeCloudflare } from "@achq/test-utils/cloudflare";
import { Deployer, Router } from "../src/infra.ts";
import { internalKey } from "../src/lib/cloudflare.ts";
import { startCommand } from "../src/lib/service-parts.ts";

let fake: FakeCloudflare;
let github: ReturnType<typeof Bun.serve>;
/** The owners Cloudflare's GitHub App is installed on. */
let installedOn: string[];
let logs: string[];
let opened: { url: string; what: string }[];
let onOpen: () => void;
let ctx: Context;
/** Whether the router's workers.dev URL answers yet. */
let answering: boolean;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fake = startFakeCloudflare({ tokens: [{ build_token_uuid: "bt-old", build_token_name: "Workers Builds - 2025" }, { build_token_uuid: "bt-new", build_token_name: "Workers Builds - 2026" }] });
  installedOn = ["djgrant"];
  github = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/user/installations"
        ? Response.json({ total_count: installedOn.length, installations: installedOn.map((login, i) => ({ id: i + 1, app_slug: "cloudflare-workers-and-pages", account: { login, type: "User" }, repository_selection: "all" })) })
        : new Response("not found", { status: 404 }),
  });
  logs = [];
  opened = [];
  onOpen = () => {};
  answering = true;
  ctx = {
    env: {
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: fake.accountId,
      CLOUDFLARE_API_URL: fake.url,
      ACHQ_CLOUDFLARE_WRANGLER: fakeWrangler(fake),
      GH_TOKEN: "gh-token",
      GITHUB_API_URL: github.url.href.replace(/\/$/, ""),
      GITHUB_WEB_URL: "https://github.test",
    },
    log: (line) => logs.push(line),
    open: async (url, what) => {
      opened.push({ url, what });
      onOpen();
    },
    newSecret: () => "generated-key",
    sleep: async () => {},
  };
  // The router's workers.dev URL, as its new version answers it.
  const real = globalThis.fetch;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(".workers.dev")) return answering ? new Response("ok") : new Response("starting", { status: 503 });
    return real(input, init);
  }) as typeof fetch);
});
afterEach(() => {
  fetchSpy.mockRestore();
  fake.stop();
  github.stop(true);
});

/** The router and deployer as `achq infra up` declares them: the deployer takes the router's generated key and its URLs. */
const declare = (ref = "a") => {
  let router!: Router;
  let deployer!: Deployer;
  achq(() => {
    router = new Router("router", { project: "achq" });
    router.variables({ ACHQ_DEPLOYER_URL: "http://3000.achq-deployer.achq.internal", ACHQ_REF: ref });
    deployer = new Deployer("deployer", { router, owners: ["djgrant"], sshKeys: ["ssh-ed25519 AAAA me"] });
    deployer.variables({ AGENT_WEBHOOK_KEY: router.key, ACHQ_ROUTER_PUBLIC_URL: router.url, ACHQ_ROUTER_URL: router.privateUrl(8081), ACHQ_REF: ref });
  })();
  return { router, deployer, resources: [router, deployer] };
};

const summary = (changes: Change[]) => changes.map((c) => [`${c.op} ${c.target} ${c.what}`, c.detail ?? c.names?.join(", ")].filter(Boolean).join(" "));

const url = "https://achq-router.acme.workers.dev";

test("a new project plans in one pass and writes nothing, with the router's URL known before it exists; a second plan is empty", async () => {
  const { router, deployer, resources } = declare();
  const planned = await plan(resources, ctx);
  expect(summary(planned.changes)).toEqual([
    "+ achq kv namespace",
    "+ achq r2 bucket",
    "+ achq-router worker",
    "~ achq-router variables AGENT_WEBHOOK_KEY, DATA_DIR, PORT",
    "~ achq-router variables ACHQ_DEPLOYER_URL, ACHQ_REF",
    "~ achq-router deploy",
    "+ achq-deployer worker",
    "~ achq-deployer build token the account's newest",
    "~ achq-deployer variables CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ACHQ_CLOUDFLARE_PROJECT, ACHQ_CLOUDFLARE_NAMESPACE, ACHQ_CLOUDFLARE_BUCKET, ACHQ_CLOUDFLARE_WORKERS_DEV, ACHQ_CLOUDFLARE_SSH_KEYS, DATA_DIR, PORT",
    "~ achq-deployer variables ACHQ_CLOUDFLARE_BUILD_TOKEN",
    "~ achq-deployer variables AGENT_WEBHOOK_KEY, ACHQ_ROUTER_PUBLIC_URL, ACHQ_ROUTER_URL, ACHQ_REF",
    "~ achq-deployer deploy",
  ]);
  expect(planned.value(router.url)).toBe(url);
  expect(planned.value(router.key)).toBe("generated-key");
  expect(planned.value(router.env)).toEqual({});
  expect(router.privateUrl(8081)).toBe("http://8081.achq-router.achq.internal");
  expect(deployer.privateUrl(3000)).toBe("http://3000.achq-deployer.achq.internal");
  expect(fake.mutations).toEqual([]);

  const applied = await planned.apply();
  expect(applied.value(router.url)).toBe(url);
  expect(applied.value(router.env)).toEqual({});
  expect(logs).toEqual(["  waiting for the router to answer…"]);

  // Its variables, readable in the project's namespace.
  const kv = fake.kv("achq")!;
  const routerVariables = JSON.parse(kv.get("services/achq-router")!);
  expect(routerVariables).toEqual({
    AGENT_WEBHOOK_KEY: "generated-key",
    DATA_DIR: "/data",
    PORT: "8080",
    ACHQ_DEPLOYER_URL: "http://3000.achq-deployer.achq.internal",
    ACHQ_REF: "a",
  });
  const deployerVariables = JSON.parse(kv.get("services/achq-deployer")!);
  expect(deployerVariables).toMatchObject({
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: fake.accountId,
    ACHQ_CLOUDFLARE_PROJECT: "achq",
    ACHQ_CLOUDFLARE_NAMESPACE: [...fake.namespaces.keys()][0],
    ACHQ_CLOUDFLARE_BUCKET: "achq",
    ACHQ_CLOUDFLARE_WORKERS_DEV: "acme.workers.dev",
    ACHQ_CLOUDFLARE_BUILD_TOKEN: "bt-new",
    ACHQ_CLOUDFLARE_SSH_KEYS: `["ssh-ed25519 AAAA me"]`,
    AGENT_WEBHOOK_KEY: "generated-key",
    ACHQ_ROUTER_PUBLIC_URL: url,
    ACHQ_ROUTER_URL: "http://8081.achq-router.achq.internal",
  });

  // Each deployed with Wrangler, its variables as its secrets.
  const deployed = fake.workers.get("achq-router")!;
  expect(deployed.secrets).toEqual({ ACHQ_ENV: JSON.stringify(routerVariables), ACHQ_INTERNAL_KEY: internalKey("generated-key") });
  expect(deployed.config).toMatchObject({
    name: "achq-router",
    workers_dev: true,
    vars: {
      ACHQ_SERVICE: {
        name: "achq-router",
        port: 8080,
        publicPort: 8080,
        sleeps: false,
        restartOnChange: true,
        image: "cloudflare/debian-trixie",
        entrypoint: startCommand("packages/service-router/src/main.ts"),
        workersDev: "acme.workers.dev",
      },
    },
    containers: [{ class_name: "Service", name: "achq-router", scheduling_policy: "durable_object" }],
  });
  expect(deployed.config.main).toEndWith("plugin-cloudflare/worker/index.ts");
  const deployerWorker = fake.workers.get("achq-deployer")!;
  expect(deployerWorker.config.vars.ACHQ_SERVICE).toMatchObject({ port: 3000, sleeps: true });
  expect(deployerWorker.config.vars.ACHQ_SERVICE.publicPort).toBeUndefined();
  expect(deployerWorker.secrets.ACHQ_INTERNAL_KEY).toBe(internalKey("generated-key"));

  const again = declare();
  const unchanged = await plan(again.resources, ctx);
  expect(unchanged.changes).toEqual([]);
  expect(unchanged.value(again.router.env)).toMatchObject({ AGENT_WEBHOOK_KEY: "generated-key", PORT: "8080" });
  expect(unchanged.value(again.deployer.env)).toMatchObject({ ACHQ_CLOUDFLARE_BUILD_TOKEN: "bt-new" });
});

test("once applied, nothing changes until an input does, and then only what depends on it", async () => {
  await (await plan(declare().resources, ctx)).apply();
  const b = declare("b");
  const changed = await plan(b.resources, ctx);
  expect(summary(changed.changes)).toEqual(["~ achq-router variables ACHQ_REF", "~ achq-router deploy", "~ achq-deployer variables ACHQ_REF", "~ achq-deployer deploy"]);
  const applied = await changed.apply();
  // Its variables before this run changed them.
  expect(applied.value(b.router.env).ACHQ_REF).toBe("a");
  expect(JSON.parse(fake.workers.get("achq-router")!.secrets.ACHQ_ENV!).ACHQ_REF).toBe("b");
});

test("the deployer keeps its build token while the account lists it; an account with none gets one through the dashboard", async () => {
  await (await plan(declare().resources, ctx)).apply();
  fake.tokens.push({ build_token_uuid: "bt-newer", build_token_name: "Workers Builds - 2027" });
  expect((await plan(declare().resources, ctx)).changes).toEqual([]);

  fake.tokens.length = 0;
  const planned = await plan(declare().resources, ctx);
  expect(summary(planned.changes)).toEqual(["+ achq-deployer build token opens Cloudflare to create one", "~ achq-deployer variables ACHQ_CLOUDFLARE_BUILD_TOKEN", "~ achq-deployer deploy"]);
  onOpen = () => fake.tokens.push({ build_token_uuid: "bt-made", build_token_name: "Workers Builds - now" });
  await planned.apply();
  expect(opened).toEqual([{ url: `https://dash.cloudflare.com/${fake.accountId}/workers/services/view/achq-deployer/production/settings`, what: "create a Workers Builds token" }]);
  expect(JSON.parse(fake.kv("achq")!.get("services/achq-deployer")!).ACHQ_CLOUDFLARE_BUILD_TOKEN).toBe("bt-made");
});

test("an owner without Cloudflare's GitHub App gets it through GitHub's install page", async () => {
  installedOn = [];
  const planned = await plan(declare().resources, ctx);
  expect(summary(planned.changes)).toContain("+ cloudflare-workers-and-pages installation on djgrant, opens GitHub to install it");
  onOpen = () => installedOn.push("DJGrant");
  await planned.apply();
  expect(opened[0]).toEqual({ url: "https://github.test/apps/cloudflare-workers-and-pages/installations/new", what: "install cloudflare-workers-and-pages on djgrant" });
  expect((await plan(declare().resources, ctx)).changes).toEqual([]);
});

test("applying waits for the router to answer, and fails if Wrangler does or it never answers", async () => {
  answering = false;
  const planned = await plan(declare().resources, ctx);
  await expect(planned.apply()).rejects.toThrow("achq-router hasn't answered after 5 minutes");

  answering = true;
  ctx.env.ACHQ_CLOUDFLARE_WRANGLER = fakeWrangler(fake, { fails: true });
  await expect((await plan(declare("b").resources, ctx)).apply()).rejects.toThrow("Wrangler couldn't deploy achq-router:\n✘ [ERROR] A request to the Cloudflare API failed.");
});

test("an account without a workers.dev subdomain can't be planned", async () => {
  fake.stop();
  fake = startFakeCloudflare({ subdomain: undefined });
  ctx.env.CLOUDFLARE_API_URL = fake.url;
  await expect(plan(declare().resources, ctx)).rejects.toThrow("has no workers.dev subdomain yet");
});

test("the deployer runs in a Cloudflare router's project", () => {
  class Elsewhere extends core.Router {
    readonly containerProvider = "elsewhere";
    readonly url = undefined as unknown as Output<string>;
    readonly key = undefined as unknown as Output<string>;
    readonly env = undefined as unknown as Output<Record<string, string>>;
    privateUrl = () => "";
    variables = () => undefined as unknown as Output<Record<string, string>>;
  }
  expect(() => achq(() => new Deployer("deployer", { router: new Elsewhere("router"), owners: [] }))()).toThrow("router must be a cloudflare.Router");
});

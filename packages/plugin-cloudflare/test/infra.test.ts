import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as core from "@achq/core";
import { achq, type Change, type Context, type Output, plan, teardown } from "@achq/core";
import { type FakeCloudflare, fakeWrangler, startFakeCloudflare } from "@achq/test-utils/fakes/vendors/cloudflare";
import { Deployer, Router } from "../src/infra.ts";
import { deployerTokenPage, forgetSignIn, internalKey } from "../src/lib/cloudflare.ts";
import { startCommand } from "../src/lib/service-parts.ts";

let fake: FakeCloudflare;
let github: ReturnType<typeof Bun.serve>;
/** What reached GitHub, which answers gh's token as it does: it can't list installations. */
let githubCalls: string[];
let logs: string[];
let opened: { url: string; what: string }[];
let onOpen: () => void;
/** What you paste when asked, in turn. */
let pasted: string[];
let asked: string[];
let ctx: Context;
/** Whether the router's workers.dev URL answers yet. */
let answering: boolean;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fake = startFakeCloudflare();
  // The token you make in the dashboard for the deployer.
  fake.apiTokens.set("cf-deployer", "tok-deployer");
  pasted = ["cf-deployer"];
  asked = [];
  githubCalls = [];
  github = Bun.serve({
    port: 0,
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      githubCalls.push(`${req.method} ${pathname}`);
      return pathname.startsWith("/user/installations")
        ? Response.json({ message: "You must authenticate with an access token authorized to a GitHub App in order to list installations" }, { status: 403 })
        : new Response("not found", { status: 404 });
    },
  });
  logs = [];
  opened = [];
  onOpen = () => {};
  answering = true;
  ctx = {
    // Signed in to Wrangler, with no token or account set.
    env: {
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
    prompt: async (message) => {
      asked.push(message);
      return pasted.shift() ?? "";
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
  forgetSignIn();
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
    "+ achq-deployer deployer token opens Cloudflare to create it, then asks for it",
    "~ achq-deployer variables CLOUDFLARE_ACCOUNT_ID, ACHQ_CLOUDFLARE_PROJECT, ACHQ_CLOUDFLARE_NAMESPACE, ACHQ_CLOUDFLARE_BUCKET, ACHQ_CLOUDFLARE_WORKERS_DEV, ACHQ_CLOUDFLARE_SSH_KEYS, DATA_DIR, PORT",
    "~ achq-deployer variables AGENT_WEBHOOK_KEY, ACHQ_ROUTER_PUBLIC_URL, ACHQ_ROUTER_URL, ACHQ_REF",
    "~ achq-deployer deploy",
  ]);
  expect(planned.value(router.url)).toBe(url);
  // Generated as it's set, so unknown until then.
  expect(planned.value(router.key)).toBe(core.UNKNOWN);
  expect(planned.value(router.env)).toEqual({});
  expect(router.privateUrl(8081)).toBe("http://8081.achq-router.achq.internal");
  expect(deployer.privateUrl(3000)).toBe("http://3000.achq-deployer.achq.internal");
  expect(fake.mutations).toEqual([]);

  const applied = await planned.apply();
  expect(applied.value(router.url)).toBe(url);
  expect(applied.value(router.key)).toBe("generated-key");
  expect(applied.value(router.env)).toEqual({});
  const page = deployerTokenPage(fake.accountId);
  expect(logs).toEqual([
    "  waiting for the router to answer…",
    "  The deployer needs a Cloudflare API token of its own. Create it with what's filled in, then paste it here. It's kept only as the deployer's secret.",
    "  ✔ The token works, and it's the deployer's secret now.",
  ]);
  expect(opened).toEqual([{ url: page, what: "create the deployer's Cloudflare token" }]);
  expect(asked).toEqual(["The deployer's Cloudflare token"]);

  // All of it as you're signed in to Wrangler, but for checking the pasted token can read the account; and none of it Workers Builds: that's the deployer's.
  expect(fake.requests.filter((r) => r.token !== "cf-oauth")).toEqual([{ call: "GET ", token: "cf-deployer" }]);
  expect(fake.requests.filter((r) => r.call.includes("/builds/"))).toEqual([]);
  expect(fake.wranglerDeploys).toEqual([
    { name: "achq-router", auth: "oauth" },
    { name: "achq-deployer", auth: "oauth" },
  ]);

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
    CLOUDFLARE_ACCOUNT_ID: fake.accountId,
    ACHQ_CLOUDFLARE_PROJECT: "achq",
    ACHQ_CLOUDFLARE_NAMESPACE: [...fake.namespaces.keys()][0],
    ACHQ_CLOUDFLARE_BUCKET: "achq",
    ACHQ_CLOUDFLARE_WORKERS_DEV: "acme.workers.dev",
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
  expect(deployed.config.main).toEndWith("cloudflare-worker/src/index.ts");
  const deployerWorker = fake.workers.get("achq-deployer")!;
  expect(deployerWorker.config.vars.ACHQ_SERVICE).toMatchObject({ port: 3000, sleeps: true });
  expect(deployerWorker.config.vars.ACHQ_SERVICE.publicPort).toBeUndefined();
  expect(deployerWorker.secrets.ACHQ_INTERNAL_KEY).toBe(internalKey("generated-key"));
  // The deployer gets no copy of your sign-in, and its own token only as its Worker's secret: not in its variables, or anywhere in the namespace.
  expect(deployerVariables.CLOUDFLARE_API_TOKEN).toBeUndefined();
  expect(deployerWorker.secrets.ACHQ_CLOUDFLARE_DEPLOYER_TOKEN).toBe("cf-deployer");
  expect(JSON.stringify([...kv.entries()])).not.toContain("cf-deployer");
  expect(JSON.stringify([...kv.entries()])).not.toContain("cf-oauth");

  const again = declare();
  const unchanged = await plan(again.resources, ctx);
  expect(unchanged.changes).toEqual([]);
  expect(unchanged.value(again.router.env)).toMatchObject({ AGENT_WEBHOOK_KEY: "generated-key", PORT: "8080" });
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

test("teardown deletes the Workers, their containers with them, then the bucket, emptied, and the namespace; the deployer's token is protected, and deleted on your API tokens page", async () => {
  await (await plan(declare().resources, ctx)).apply();
  fake.buckets.get("achq")!.set("achq-router/data.tar.gz", "archive");
  const planned = await teardown(declare().resources, ctx);
  expect(summary(planned.changes)).toEqual([
    "- deployer/worker cloudflare-worker",
    "- router/worker cloudflare-worker",
    "- router/project/bucket cloudflare-r2-bucket",
    "- router/project/namespace cloudflare-kv-namespace",
  ]);
  expect(planned.protected).toEqual([{ target: "deployer/deployer-token", what: "cloudflare-deployer-token", page: "https://dash.cloudflare.com/profile/api-tokens" }]);
  expect(fake.workers.size).toBe(2);

  await planned.apply();
  expect(fake.workers.size).toBe(0);
  expect(fake.applications).toEqual([]);
  expect(fake.buckets.size).toBe(0);
  expect(fake.namespaces.size).toBe(0);
  const again = await teardown(declare().resources, ctx);
  expect(again.changes).toEqual([]);
  expect(again.protected).toEqual([]);
});

test("a pasted token that won't do is asked for again, and rotating makes a new one", async () => {
  // Wrangler's own token isn't an API token, and one Cloudflare doesn't know is turned down.
  pasted = [fake.oauthToken, "typo", "cf-deployer"];
  await (await plan(declare().resources, ctx)).apply();
  expect(asked).toHaveLength(3);
  expect(logs.filter((l) => l.startsWith("  !"))).toEqual([
    "  ! Cloudflare turned that token down (Cloudflare GET /user/tokens/verify: 401 Invalid API Token (1000)). Paste it again.",
    "  ! Cloudflare turned that token down (Cloudflare GET /user/tokens/verify: 401 Invalid API Token (1000)). Paste it again.",
  ]);
  expect(fake.workers.get("achq-deployer")!.secrets.ACHQ_CLOUDFLARE_DEPLOYER_TOKEN).toBe("cf-deployer");
  expect((await plan(declare().resources, ctx)).changes).toEqual([]);

  const rotated = declare();
  rotated.deployer.rotateToken();
  const planned = await plan(rotated.resources, ctx);
  expect(summary(planned.changes)).toEqual(["~ achq-deployer deployer token opens Cloudflare to create a new one, then asks for it"]);
  fake.apiTokens.set("cf-deployer-2", "tok-deployer-2");
  pasted = ["cf-deployer-2"];
  await planned.apply();
  expect(fake.workers.get("achq-deployer")!.secrets.ACHQ_CLOUDFLARE_DEPLOYER_TOKEN).toBe("cf-deployer-2");

  pasted = ["typo", "typo", "typo"];
  const again = declare();
  again.deployer.rotateToken();
  await expect((await plan(again.resources, ctx)).apply()).rejects.toThrow("Cloudflare turned that token down");
  expect(fake.workers.get("achq-deployer")!.secrets.ACHQ_CLOUDFLARE_DEPLOYER_TOKEN).toBe("cf-deployer-2");
});

test("without a browser and a terminal to paste into, the deployer's token can't be made", async () => {
  const { prompt: _, ...withoutPrompt } = ctx;
  await expect((await plan(declare().resources, withoutPrompt)).apply()).rejects.toThrow("The deployer's Cloudflare token is made in your browser and pasted here, which only `achq infra up` can do");
});

test("Cloudflare's GitHub App isn't checked, which only Cloudflare can do: up says nothing of it, and asks GitHub nothing", async () => {
  const planned = await plan(declare().resources, ctx);
  expect(summary(planned.changes).filter((c) => c.includes("cloudflare-workers-and-pages"))).toEqual([]);
  await planned.apply();
  expect(logs.filter((l) => l.includes("cloudflare-workers-and-pages"))).toEqual([]);
  expect(opened.map((o) => o.what)).not.toContain("install cloudflare-workers-and-pages on djgrant");
  expect(githubCalls).toEqual([]);
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
    readonly plugin = core.CORE_PLUGIN;
    readonly containerProvider = "elsewhere";
    readonly url = undefined as unknown as Output<string>;
    protected readonly placement = undefined as unknown as core.Placement;
  }
  expect(() => achq(() => new Deployer("deployer", { router: new Elsewhere("router"), owners: [] }))()).toThrow("router must be a cloudflare.Router");
});

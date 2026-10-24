import { afterEach, beforeEach, expect, test } from "bun:test";
import { BrowserActionNeeded } from "@achq/core";
import { gunzipSync } from "node:zlib";
import { type FakeCloudflare, startFakeCloudflare } from "@achq/test-utils/cloudflare";
import { Cloudflare } from "@achq/utils/cloudflare";
import { cloudflareContainerProvider } from "../src/container/index.ts";
import { CloudflareContainerProvider } from "../src/container/provider.ts";
import { internalKey } from "../src/lib/cloudflare.ts";

let fake: FakeCloudflare;
let host: CloudflareContainerProvider;
let namespaceId: string;

const spec = {
  host: "github",
  repo: "NotationLabs/yieldstar",
  identity: { id: "22", name: "yieldstar", owner: { id: "11", name: "NotationLabs" } },
  name: "dev",
  dockerfile: ".achq/Dockerfile",
  branch: "main",
  // As the deployer sets them.
  env: {
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    ACHQ_REPO: "NotationLabs/yieldstar",
    ACHQ_CONTAINER: "dev",
    ACHQ_ROUTER_URL: "http://8081.achq-router.achq.internal",
    ACHQ_REF: "abc123",
  },
};

const worker = "achq-notationlabs-yieldstar-dev";

const options = () => ({
  // Its own token, which you made: never yours.
  token: "cf-deployer",
  accountId: fake.accountId,
  endpoint: fake.url,
  project: "achq",
  namespaceId,
  bucket: "achq",
  workersDev: "acme.workers.dev",
  sshKeys: ["ssh-ed25519 AAAA achq container ssh"],
  key: "webhook-key",
  sleep: async () => {},
  log: (line: string) => logs.push(line),
});

let logs: string[];

/** The Builds token registered for the deployer's own. */
const registeredToken = () => fake.tokens.find((t) => t.cloudflare_token_id === "tok-deployer")?.build_token_uuid;

beforeEach(async () => {
  // One made in the dashboard.
  fake = startFakeCloudflare({ tokens: [{ build_token_uuid: "bt-1", build_token_name: "Workers Builds" }] });
  fake.apiTokens.set("cf-deployer", "tok-deployer");
  logs = [];
  namespaceId = await new Cloudflare("cf-token", fake.accountId, fake.url).kv.createNamespace("achq");
  fake.buckets.set("achq", new Map());
  host = new CloudflareContainerProvider(options());
  fake.mutations.length = 0;
  fake.requests.length = 0;
});
afterEach(() => fake.stop());

test("a repo Cloudflare's GitHub App can't see fails ensure with what only you can do: install the App, at its install page", async () => {
  fake.unseen.add("NotationLabs/yieldstar");
  const failure = await host.ensure(spec).catch((e) => e);
  expect(failure).toBeInstanceOf(BrowserActionNeeded);
  expect(failure.action).toEqual({ url: "https://github.com/apps/cloudflare-workers-and-pages/installations/new", what: "install cloudflare-workers-and-pages on NotationLabs/yieldstar" });
  expect(failure.message).toContain("Workers Builds can't see NotationLabs/yieldstar");
  expect(failure.message).toContain("(8000012)");
  expect(fake.triggers.size).toBe(0);

  // Once it's installed, the same ensure connects it.
  fake.unseen.clear();
  await host.ensure(spec);
  expect(fake.triggers.size).toBe(1);
});

/** The container Worker's config, as its build writes it from its trigger's variable. */
const builtConfig = () => {
  const trigger = [...fake.triggers.values()][0]!;
  return JSON.parse(gunzipSync(Buffer.from(trigger.variables.ACHQ_WRANGLER_CONFIG!.value, "base64")).toString());
};

test("ensure makes a placeholder Worker, its variables and secrets, and a trigger that only the deployer starts; a second ensure changes nothing", async () => {
  expect((await host.plan(spec)).map((c) => `${c.op} ${c.target} ${c.what}`)).toEqual([
    `+ ${worker} worker`,
    `~ ${worker} variables`,
    `~ ${worker} secrets`,
    `+ ${worker} build trigger`,
  ]);
  expect(fake.mutations).toEqual([]);

  expect(await host.ensure(spec)).toEqual({ url: `http://3000.${worker}.achq.internal` });
  // Its own token, registered with Workers Builds by its id.
  expect(fake.tokens.at(-1)).toMatchObject({ build_token_name: "achq-deployer", cloudflare_token_id: "tok-deployer" });
  const made = fake.workers.get(worker)!;
  expect(made.source).toContain("not deployed yet");
  const variables = { ...spec.env, DATA_DIR: "/data", PORT: "3000", ACHQ_KEEP_AWAKE_URL: "http://awake.achq.internal/" };
  expect(JSON.parse(fake.kv("achq")!.get(`containers/${worker}`)!)).toEqual(variables);
  expect(made.secrets).toEqual({ ACHQ_ENV: JSON.stringify(variables), ACHQ_INTERNAL_KEY: internalKey("webhook-key") });

  // Connected by GitHub's ids for the repo, as its code host gave them.
  expect(fake.connections).toEqual([expect.objectContaining({ provider_type: "github", provider_account_id: "11", provider_account_name: "NotationLabs", repo_id: "22", repo_name: "yieldstar" })]);
  const trigger = [...fake.triggers.values()][0]!;
  expect(trigger).toMatchObject({
    external_script_id: made.id,
    build_token_uuid: registeredToken(),
    branch_includes: ["main"],
    // Pushes match no path, so only the deployer builds.
    path_includes: ["achq-never-matches/**"],
    path_excludes: ["*"],
    root_directory: "/",
  });
  expect(trigger.deploy_command).not.toBe("npx wrangler deploy");
  expect(trigger.deploy_command).toContain("wrangler@4 deploy --config .achq-wrangler.json");
  // The achq Worker comes from achq at the container's ACHQ_REF.
  expect(trigger.build_command).toContain("https://codeload.github.com/djgrant/achq/tar.gz/$ACHQ_REF");
  expect(trigger.variables.ACHQ_REF).toEqual({ value: "abc123", is_secret: false });
  expect(builtConfig()).toMatchObject({
    name: worker,
    main: ".achq-worker/index.ts",
    compatibility_flags: ["global_fetch_strictly_public"],
    vars: { ACHQ_SERVICE: { name: worker, port: 3000, sleeps: true, restartOnChange: false, image: "app", instance: "standard-1", workersDev: "acme.workers.dev" } },
    r2_buckets: [{ binding: "ARCHIVE", bucket_name: "achq" }],
    containers: [
      {
        class_name: "Service",
        scheduling_policy: "durable_object",
        images: { app: { dockerfile: "./.achq/Dockerfile", build_context: "." } },
        // Without its comment, which Cloudflare refuses with spaces in it.
        authorized_keys: [{ name: "achq-1", public_key: "ssh-ed25519 AAAA" }],
      },
    ],
  });
  expect(builtConfig().vars.ACHQ_SERVICE.publicPort).toBeUndefined();

  fake.mutations.length = 0;
  expect(await host.plan(spec)).toEqual([]);
  await host.ensure(spec);
  expect(fake.mutations).toEqual([]);
});

test("the deployer registers its token with Workers Builds once, and keeps it", async () => {
  await host.ensure(spec);
  const uuid = registeredToken()!;
  // Another deployer process, as after a restart.
  await new CloudflareContainerProvider(options()).ensure({ ...spec, name: "docs", env: { ...spec.env, ACHQ_CONTAINER: "docs" } });
  expect(fake.tokens.filter((t) => t.cloudflare_token_id === "tok-deployer")).toHaveLength(1);
  expect([...fake.triggers.values()].map((t) => t.build_token_uuid)).toEqual([uuid, uuid]);
  // All of it with its own token.
  expect(new Set(fake.requests.map((r) => r.token))).toEqual(new Set(["cf-deployer"]));
});

test("if Workers Builds won't register its token, the deployer builds with the account's newest; with none, it says where to make one", async () => {
  fake.registerFails = true;
  await host.ensure(spec);
  expect([...fake.triggers.values()][0]!.build_token_uuid).toBe("bt-1");
  expect(logs).toEqual(["Workers Builds wouldn't take the deployer's token (Cloudflare POST /accounts/acct/builds/tokens: 400 Unable to create build token (400)); building with Workers Builds"]);

  fake.tokens.length = 0;
  await expect(new CloudflareContainerProvider(options()).ensure(spec)).rejects.toThrow(
    `and the account has no other. Make one at https://dash.cloudflare.com/acct/workers/services/view/${worker}/production/settings`,
  );
});

test("ensure sets only what changed: a variable and its secrets, or the branch", async () => {
  await host.ensure(spec);
  fake.mutations.length = 0;
  const changed = { ...spec, branch: "trunk", env: { ...spec.env, CLAUDE_CODE_OAUTH_TOKEN: "new" } };
  expect((await host.plan(changed)).map((c) => `${c.op} ${c.what} ${c.detail ?? c.names}`)).toEqual([
    "~ variables CLAUDE_CODE_OAUTH_TOKEN", // names, never values
    "~ secrets ACHQ_ENV,ACHQ_INTERNAL_KEY",
    "~ build trigger branch_includes",
  ]);
  await host.ensure(changed);
  expect([...fake.triggers.values()][0]!.branch_includes).toEqual(["trunk"]);
  expect(fake.mutations.filter((m) => m.includes("triggers"))).toEqual([`PATCH /builds/triggers/${[...fake.triggers.keys()][0]}`]);
});

test("deploy builds the trigger's branch and waits for its version; a failed build throws with the end of its log", async () => {
  await host.ensure(spec);
  await host.deploy(spec.repo, "dev");
  const [build] = fake.builds.values();
  expect(build!.branch).toBe("main");
  expect(await host.image(worker, build!.build_uuid)).toStartWith(`registry.cloudflare.com/${fake.accountId}/${worker}-app@sha256:`);

  fake.nextBuild = { outcome: "fail", log: ["Cloning repository...", "#5 ERROR: failed to solve: apt-get exited 100"], deploysVersion: false };
  const failed = host.deploy(spec.repo, "dev");
  await expect(failed).rejects.toThrow(`${worker}'s build fail:\nCloning repository...\n#5 ERROR: failed to solve: apt-get exited 100`);

  // Wrangler pushed the image, but the Worker upload failed.
  fake.nextBuild = { outcome: "success", log: [], deploysVersion: false };
  await expect(host.deploy(spec.repo, "dev")).rejects.toThrow("deployed no version with a container image");

  await expect(host.deploy(spec.repo, "docs")).rejects.toThrow("No Cloudflare Worker achq-notationlabs-yieldstar-docs; ensure it first");
});

test("list reads containers' repo and name, locate says where, remove deletes the Worker and all that's kept for it", async () => {
  await host.ensure(spec);
  await host.ensure({ ...spec, name: "docs", env: { ...spec.env, ACHQ_CONTAINER: "docs" } });
  expect(await host.list()).toEqual([
    { repo: spec.repo, name: "dev" },
    { repo: spec.repo, name: "docs" },
  ]);
  // Its container application only exists once a build has deployed it.
  expect(await host.locate(spec.repo, "dev")).toEqual({ containerProvider: "cloudflare", account: fake.accountId, worker });
  await host.deploy(spec.repo, "dev");
  const application = fake.applications.find((a) => a.name === worker)!;
  expect(await host.locate(spec.repo, "dev")).toEqual({ containerProvider: "cloudflare", account: fake.accountId, worker, application: application.id });

  fake.buckets.get("achq")!.set(`${worker}/data.tar.gz`, "archive");
  await host.remove(spec.repo, "dev");
  expect(fake.workers.has(worker)).toBe(false);
  expect(fake.applications.some((a) => a.name === worker)).toBe(false);
  expect([...fake.triggers.values()].map((t) => t.external_script_id)).toEqual([fake.workers.get("achq-notationlabs-yieldstar-docs")!.id]);
  expect(fake.buckets.get("achq")!.size).toBe(0);
  expect([...fake.kv("achq")!.keys()].filter((k) => k.includes("-dev"))).toEqual([]);
  expect(await host.list()).toEqual([{ repo: spec.repo, name: "docs" }]);
  await host.remove(spec.repo, "dev"); // already gone: nothing to do
  expect(registeredToken()).toBeDefined();

  // The last one takes the Builds token's registration with it, but not a token it didn't register; the next ensure registers it again.
  await host.remove(spec.repo, "docs");
  expect(registeredToken()).toBeUndefined();
  expect(fake.tokens.map((t) => t.build_token_uuid)).toEqual(["bt-1"]);
  await host.ensure(spec);
  expect(registeredToken()).toBeDefined();
});

test("only builds repos on GitHub, at a known achq commit", async () => {
  await expect(host.ensure({ ...spec, host: "gitlab" })).rejects.toThrow("Cloudflare builds containers from github repos, not gitlab");
  const { ACHQ_REF: _, ...withoutRef } = spec.env;
  await expect(host.ensure({ ...spec, env: withoutRef })).rejects.toThrow("has no ACHQ_REF");
});

test("the deployer makes it from its environment", async () => {
  expect(cloudflareContainerProvider.id).toBe("cloudflare");
  expect(cloudflareContainerProvider.privateEnv).toEqual(["CLOUDFLARE_API_TOKEN", "ACHQ_CLOUDFLARE_DEPLOYER_TOKEN"]);
  // Its own token, never yours.
  expect(() => cloudflareContainerProvider.create({ AGENT_WEBHOOK_KEY: "k", CLOUDFLARE_API_TOKEN: "t" })).toThrow("Missing ACHQ_CLOUDFLARE_DEPLOYER_TOKEN");
  expect(() => cloudflareContainerProvider.create({ AGENT_WEBHOOK_KEY: "k", ACHQ_CLOUDFLARE_DEPLOYER_TOKEN: "t" })).toThrow("Missing CLOUDFLARE_ACCOUNT_ID");
  const made = cloudflareContainerProvider.create({
    AGENT_WEBHOOK_KEY: "webhook-key",
    ACHQ_ROUTER_URL: "http://8081.achq-router.achq.internal",
    ACHQ_CLOUDFLARE_DEPLOYER_TOKEN: "cf-deployer",
    CLOUDFLARE_ACCOUNT_ID: fake.accountId,
    CLOUDFLARE_API_URL: fake.url,
    ACHQ_CLOUDFLARE_PROJECT: "achq",
    ACHQ_CLOUDFLARE_NAMESPACE: namespaceId,
    ACHQ_CLOUDFLARE_BUCKET: "achq",
    ACHQ_CLOUDFLARE_WORKERS_DEV: "acme.workers.dev",
  }) as CloudflareContainerProvider;
  expect(made.options).toMatchObject({ token: "cf-deployer", project: "achq", namespaceId, sshKeys: [], key: "webhook-key" });
  expect(await made.list()).toEqual([]);
});

test("the router and deployer keep what they store in their Durable Object, which their Worker answers at store.achq.internal", async () => {
  const requests: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await cloudflareContainerProvider.store({}, "inbox").write("d-1", { n: 1 });
  } finally {
    globalThis.fetch = real;
  }
  expect(requests).toEqual(["PUT http://store.achq.internal/inbox/d-1"]);
});

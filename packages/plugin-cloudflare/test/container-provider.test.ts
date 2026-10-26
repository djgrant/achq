import { afterEach, beforeEach, expect, test } from "bun:test";
import { BrowserActionNeeded } from "@achq/core";
import { serve } from "@achq/core/commands";
import { gunzipSync } from "node:zlib";
import { type FakeCloudflare, startFakeCloudflare } from "@achq/test-utils/fakes/vendors/cloudflare";
import { Cloudflare } from "@achq/utils/cloudflare";
import { cloudflareContainerProvider } from "../src/container/index.ts";
import { CloudflareContainerProvider } from "../src/container/provider.ts";
import { internalKey } from "../src/lib/cloudflare.ts";

const NO_BUILD = { build: false };
const BUILD = { build: true };

let fake: FakeCloudflare;
let host: CloudflareContainerProvider;
let namespaceId: string;

const spec = {
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
    ACHQ_VERSION: "0.2.0",
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
  const failure = await host.ensure(spec, NO_BUILD).catch((e) => e);
  expect(failure).toBeInstanceOf(BrowserActionNeeded);
  expect(failure.action).toEqual({ url: "https://github.com/apps/cloudflare-workers-and-pages/installations/new", what: "install cloudflare-workers-and-pages on NotationLabs/yieldstar" });
  expect(failure.message).toContain("Workers Builds can't see NotationLabs/yieldstar");
  expect(failure.message).toContain("(8000012)");
  expect(fake.triggers.size).toBe(0);

  // Once it's installed, the same ensure connects it.
  fake.unseen.clear();
  await host.ensure(spec, NO_BUILD);
  expect(fake.triggers.size).toBe(1);
});

/** The container Worker's config, as its build writes it from its trigger's variable. */
const builtConfig = () => {
  const trigger = [...fake.triggers.values()][0]!;
  return JSON.parse(gunzipSync(Buffer.from(trigger.variables.ACHQ_WRANGLER_CONFIG!.value, "base64")).toString());
};

test("ensure makes a placeholder Worker, its variables and secrets, and a trigger that only the deployer starts; a second ensure changes nothing", async () => {
  expect(await host.ensure(spec, NO_BUILD)).toEqual({ url: `http://3000.${worker}.achq.internal` });
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
  // The achq Worker comes from npm, at the container's ACHQ_VERSION, with the one module of utils it imports.
  expect(trigger.build_command).toContain(`"https://registry.npmjs.org/@achq/cloudflare-worker/-/cloudflare-worker-$ACHQ_VERSION.tgz"`);
  expect(trigger.build_command).toContain(`"https://registry.npmjs.org/@achq/utils/-/utils-$ACHQ_VERSION.tgz"`);
  expect(trigger.variables.ACHQ_VERSION).toEqual({ value: "0.2.0", is_secret: false });
  expect(builtConfig()).toMatchObject({
    name: worker,
    main: ".achq-worker/node_modules/@achq/cloudflare-worker/src/index.ts",
    compatibility_flags: ["global_fetch_strictly_public"],
    // Its Durable Object starts it with the runner, not the Dockerfile's CMD.
    vars: { ACHQ_SERVICE: { name: worker, port: 3000, sleeps: true, restartOnChange: false, image: "app", entrypoint: serve(), instance: "standard-1", workersDev: "acme.workers.dev" } },
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
  await host.ensure(spec, NO_BUILD);
  expect(fake.mutations).toEqual([]);
});

test("the deployer registers its token with Workers Builds once, and keeps it", async () => {
  await host.ensure(spec, NO_BUILD);
  const uuid = registeredToken()!;
  // Another deployer process, as after a restart.
  await new CloudflareContainerProvider(options()).ensure({ ...spec, name: "docs", env: { ...spec.env, ACHQ_CONTAINER: "docs" } }, NO_BUILD);
  expect(fake.tokens.filter((t) => t.cloudflare_token_id === "tok-deployer")).toHaveLength(1);
  expect([...fake.triggers.values()].map((t) => t.build_token_uuid)).toEqual([uuid, uuid]);
  // All of it with its own token.
  expect(new Set(fake.requests.map((r) => r.token))).toEqual(new Set(["cf-deployer"]));
});

test("if Workers Builds won't register its token, the deployer builds with the account's newest; with none, it says where to make one", async () => {
  fake.registerFails = true;
  await host.ensure(spec, NO_BUILD);
  expect([...fake.triggers.values()][0]!.build_token_uuid).toBe("bt-1");
  expect(logs).toEqual(["Workers Builds wouldn't take the deployer's token (Cloudflare POST /accounts/acct/builds/tokens: 400 Unable to create build token (400)); building with Workers Builds"]);

  fake.tokens.length = 0;
  await expect(new CloudflareContainerProvider(options()).ensure(spec, NO_BUILD)).rejects.toThrow(
    `and the account has no other. Make one at https://dash.cloudflare.com/acct/workers/services/view/${worker}/production/settings`,
  );
});

test("ensure sets only what changed: a variable and its secrets, or the branch", async () => {
  await host.ensure(spec, NO_BUILD);
  fake.mutations.length = 0;
  const changed = { ...spec, branch: "trunk", env: { ...spec.env, CLAUDE_CODE_OAUTH_TOKEN: "new" } };
  await host.ensure(changed, NO_BUILD);
  expect(JSON.parse(fake.kv("achq")!.get(`containers/${worker}`)!).CLAUDE_CODE_OAUTH_TOKEN).toBe("new");
  expect([...fake.triggers.values()][0]!.branch_includes).toEqual(["trunk"]);
  // The variables, kept and as secrets, and the trigger's branch: no new Worker or trigger.
  expect(fake.mutations).toEqual([
    `PUT /storage/kv/namespaces/${namespaceId}/values/containers%2F${worker}`,
    `PUT /workers/scripts/${worker}/secrets`,
    `PUT /workers/scripts/${worker}/secrets`,
    `PUT /storage/kv/namespaces/${namespaceId}/values/deployed%2F${worker}`,
    `PATCH /builds/triggers/${[...fake.triggers.keys()][0]}`,
  ]);
});

test("a build builds the spec's branch with the trigger and waits for its version; a failed build throws with the end of its log", async () => {
  await host.ensure(spec, BUILD);
  const [build] = fake.builds.values();
  expect(build!.branch).toBe("main");
  expect(await host.image(worker, build!.build_uuid)).toStartWith(`registry.cloudflare.com/${fake.accountId}/${worker}-app@sha256:`);

  fake.nextBuild = { outcome: "fail", log: ["Cloning repository...", "#5 ERROR: failed to solve: apt-get exited 100"], deploysVersion: false };
  const failed = host.ensure(spec, BUILD);
  await expect(failed).rejects.toThrow(`${worker}'s build fail:\nCloning repository...\n#5 ERROR: failed to solve: apt-get exited 100`);

  // Wrangler pushed the image, but the Worker upload failed.
  fake.nextBuild = { outcome: "success", log: [], deploysVersion: false };
  await expect(host.ensure(spec, BUILD)).rejects.toThrow("deployed no version with a container image");
});

test("list reads containers' repo and name, shell reaches the running instance, remove deletes the Worker and all that's kept for it", async () => {
  await host.ensure(spec, NO_BUILD);
  await host.ensure({ ...spec, name: "docs", env: { ...spec.env, ACHQ_CONTAINER: "docs" } }, NO_BUILD);
  expect(await host.list()).toEqual([
    { repo: spec.repo, name: "dev" },
    { repo: spec.repo, name: "docs" },
  ]);
  // Its container application only exists once a build has deployed it.
  await expect(host.shell(spec.repo, "dev", [], true)).rejects.toThrow(`${worker} has no container yet`);
  await host.ensure(spec, BUILD);
  const application = fake.applications.find((a) => a.name === worker)!;
  // To its Durable Object's id, with the container's environment, through Wrangler as you're signed in to the account.
  expect(await host.shell(spec.repo, "dev", ["achq-runner", "sessions"], false)).toEqual({
    argv: ["npx", "-y", "wrangler@4", "containers", "ssh", `do-${application.id}`, "--", "sh", "-c", 'set -a; . /run/achq/env; exec "$@"', "sh", "achq-runner", "sessions"],
    env: { CLOUDFLARE_ACCOUNT_ID: fake.accountId },
    requires: [{ binary: "npx", install: "install Node.js, which comes with it" }],
  });
  expect((await host.shell(spec.repo, "dev", [], true)).argv.slice(3, 8)).toEqual(["containers", "ssh", `do-${application.id}`, "--tty", "--"]);

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
  await host.ensure(spec, NO_BUILD);
  expect(registeredToken()).toBeDefined();
});

test("only builds at a known achq version", async () => {
  const { ACHQ_VERSION: _, ...withoutVersion } = spec.env;
  await expect(host.ensure({ ...spec, env: withoutVersion }, NO_BUILD)).rejects.toThrow("has no ACHQ_VERSION");
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
  expect(requests).toEqual(["PUT http://store.achq.internal/inbox?name=d-1"]);
});

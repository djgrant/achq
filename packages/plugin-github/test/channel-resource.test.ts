import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import {
  type Change,
  type Context,
  type EnvValue,
  type Vault,
  type EnvValues,
  ManagedResource,
  Output,
  type Placement,
  type Planned,
  plan,
  resetDeclarations,
  Router,
  UNKNOWN,
} from "@achq/core";
import { appsVariable, appWebhookSecret } from "../src/lib/apps.ts";
import { Channel } from "../src/channel/resource.ts";

const { privateKey: pem, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const PERMISSIONS = { contents: "write", issues: "write", pull_requests: "write", metadata: "read", actions_variables: "write" };
const ROUTER = "https://router.example";
const HOOK = `${ROUTER}/webhook`;

let gh: ReturnType<typeof Bun.serve>;
let calls: { method: string; path: string; jwtOk: boolean }[];
let hook: { url?: string; content_type?: string; insecure_ssl?: string; secret?: string };
let settings: { events: string[]; permissions: Record<string, string> };

const jwtValid = (auth: string | null) => {
  const [h, p, s] = (auth?.replace(/^bearer /i, "") ?? "").split(".");
  return Boolean(s) && createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey(publicKey), s, "base64url");
};

beforeEach(() => {
  resetDeclarations();
  calls = [];
  hook = {};
  settings = { events: ["issues", "issue_comment", "push"], permissions: PERMISSIONS };
  gh = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push({ method: req.method, path: url.pathname, jwtOk: jwtValid(req.headers.get("authorization")) });
      if (req.method === "POST" && url.pathname === "/app-manifests/the-code/conversions") {
        return Response.json({ id: 4242, slug: "djgrant-claude", pem, html_url: "https://github.com/apps/djgrant-claude" });
      }
      // As GitHub answers a JWT signed with a key it doesn't know.
      if ((url.pathname === "/app" || url.pathname === "/app/hook/config") && !calls.at(-1)!.jwtOk) return Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 });
      if (url.pathname === "/app/hook/config") {
        if (req.method === "PATCH") Object.assign(hook, await req.json());
        return Response.json({ ...hook, secret: "********" });
      }
      if (url.pathname === "/app") return Response.json(settings);
      return new Response("not found", { status: 404 });
    },
  });
});
afterEach(() => gh.stop(true));

const web = () => `http://localhost:${gh.port}`;

/** A "browser" that follows the manifest page to GitHub and back. */
const open = async (page: string, what: string) => {
  expect(what).toBe("create djgrant-claude on GitHub");
  const html = await (await fetch(page)).text();
  const state = html.match(/state=([0-9a-f]+)/)![1];
  const manifest = JSON.parse(html.match(/value='([^']*)'/)![1].replace(/&#39;/g, "'"));
  expect(manifest.hook_attributes).toEqual({ url: HOOK, active: true });
  expect((await fetch(`${manifest.redirect_url}?code=the-code&state=${state}`)).ok).toBe(true);
};

/** A vault in memory: its items by name. */
const memoryVault = (items = new Map<string, Record<string, string>>()): Vault & { items: typeof items } => ({
  items,
  read: async (item) => items.get(item),
  write: async (item, fields) => void items.set(item, fields),
});

const context = (log: string[] = [], withOpen = true, vault?: Vault): Context => ({
  env: { GITHUB_API_URL: web(), GITHUB_WEB_URL: web() },
  log: (line) => log.push(line),
  ...(withOpen && { open }),
  ...(vault && { vault }),
  newSecret: () => "secret",
  sleep: async () => {},
});

type Service = { url: string; key: string; env: Record<string, string>; exists: boolean };

/** What the router's URL, key and variables come from. A new one's URL is only known once it's applied. */
class RouterService extends ManagedResource<Service, true, Omit<Service, "exists">, "create"> {
  readonly kind = "service";
  read = async ({ exists }: Service) => (exists ? (true as const) : undefined);
  diff = (_: Service, current: true | undefined) => (current ? [] : ["create" as const]);
  describe = (): Change => ({ op: "+", target: "router", what: "service" });
  planned = ({ url, key, env }: Service, current: true | undefined): Planned<Omit<Service, "exists">> => ({ url: current ? url : UNKNOWN, key, env });
  apply = async ({ url, key, env }: Service) => ({ url, key, env });
}

/** A router whose variable groups are recorded, not set. */
class StubRouter extends Router {
  readonly containerProvider = "stub";
  readonly url: Output<string>;
  readonly env: Output<Record<string, string>>;
  readonly groups: (EnvValues | ((ctx: Context) => EnvValues))[] = [];
  protected readonly placement = undefined as unknown as Placement;
  private readonly service: RouterService;

  constructor(service: Service) {
    super("router");
    this.service = new RouterService("service", service, { parent: this });
    [this.url, this.env] = [this.service.out("url"), this.service.out("env")];
  }
  override get key() {
    return this.service.out("key");
  }
  override children() {
    return [];
  }
  variables(values: EnvValues | ((ctx: Context) => EnvValues)) {
    this.groups.push(values);
    return new Output<Record<string, string>>([], () => ({}));
  }
  apps(ctx: Context): EnvValue {
    expect(this.groups.length).toBe(1);
    const group = this.groups[0]!;
    return (typeof group === "function" ? group(ctx) : group).ACHQ_GITHUB_APPS!;
  }
}

const KEY = "the-webhook-key";
const STORED = { "djgrant-claude": { id: "4242", privateKey: pem } };
const OTHER = { "old-app": { id: "7", privateKey: "old-key" } };

const infra = (stored: object, router: Partial<Service> = {}) => {
  const r = new StubRouter({ url: ROUTER, key: KEY, exists: true, env: { ACHQ_GITHUB_APPS: appsVariable(stored as never) }, ...router });
  return { router: r, channel: new Channel("personal", { name: "djgrant-claude", router: r }) };
};

const summary = (changes: Change[]) => changes.map((c) => `${c.op} ${c.target} ${c.what}${c.detail ? ` ${c.detail}` : ""}`);

test("a channel's comparison is pure: it takes what was read and says what differs", () => {
  const { router } = infra({});
  const channel = new Channel("org", { name: "Notation ACHQ", org: "notationlabs", router });
  const props = { slug: "notation-achq", name: "Notation ACHQ", org: "notationlabs", hookUrl: HOOK, key: KEY };
  expect(channel.slug).toBe("notation-achq");

  const create = channel.diff(props, undefined);
  expect(create.map((c) => channel.describe(c, props))).toEqual([{ op: "+", target: "Notation ACHQ (notationlabs)", what: "github channel", detail: "opens GitHub to create its App" }]);
  expect(channel.planned(props, undefined)).toEqual({ slug: UNKNOWN, id: UNKNOWN, privateKey: UNKNOWN });

  const known = { ...props, stored: { id: "1", privateKey: "k" } };
  const settingsUrl = "https://github.com/organizations/notationlabs/settings/apps/notation-achq/permissions";
  const current = {
    events: ["issues", "push"],
    permissions: { ...PERMISSIONS, contents: "read" },
    hook: { url: HOOK, content_type: "json", insecure_ssl: "0" },
    settings: settingsUrl,
    keys: known.stored,
    onRouter: true,
  };
  expect(channel.diff(known, current)).toEqual([]);
  expect(channel.planned(known, current)).toEqual({ slug: "notation-achq", id: "1", privateKey: "k" });
  expect(channel.check(known, current)).toEqual([
    `notation-achq doesn't send issue_comment: change it at ${settingsUrl}`,
    `notation-achq lacks contents: write: change it at ${settingsUrl}`,
  ]);
  // GitHub has no API to delete an App.
  expect(channel.protect).toBe(true);

  const drifted = { ...current, hook: { ...current.hook, insecure_ssl: "1" } };
  expect(channel.diff(known, drifted).map((c) => channel.describe(c, known))).toEqual([{ op: "~", target: "notation-achq", what: "webhook", detail: `→ ${HOOK}` }]);
  // A new router's URL isn't known yet, so it differs from whatever the webhook has.
  const unknown = { ...known, hookUrl: UNKNOWN as never };
  expect(channel.diff(unknown, current).map((c) => channel.describe(c, unknown))).toEqual([{ op: "~", target: "notation-achq", what: "webhook", detail: "→ the router's URL" }]);
});

test("a new channel plans as a create without calling GitHub, then is created with its webhook secret", async () => {
  const log: string[] = [];
  const { router, channel } = infra(OTHER);
  const ctx = context(log);
  const keys = router.apps(ctx);
  const planned = await plan([channel], ctx);
  expect(summary(planned.changes)).toEqual(["+ djgrant-claude github channel opens GitHub to create its App"]);
  expect(planned.value(keys)).toBe(UNKNOWN);
  expect(calls).toEqual([]);

  const applied = await planned.apply();
  expect(hook).toEqual({ url: HOOK, content_type: "json", insecure_ssl: "0", secret: appWebhookSecret(KEY, 4242) });
  expect(calls.filter((c) => c.method === "PATCH").every((c) => c.jwtOk)).toBe(true);
  expect(log).toEqual(["  created https://github.com/apps/djgrant-claude"]);
  // The undeclared App's key is kept alongside the new one.
  expect(JSON.parse(applied.value(keys) as string)).toEqual({ ...OTHER, "djgrant-claude": { id: "4242", privateKey: pem } });
});

test("creating a channel's App without a browser to open fails, saying so", async () => {
  const { channel } = infra({});
  const planned = await plan([channel], context([], false));
  await expect(planned.apply()).rejects.toThrow("Creating GitHub App djgrant-claude opens your browser, which only `achq infra up` can do");
});

test("a known channel's drifted webhook plans as a change and is fixed", async () => {
  hook = { url: "https://old.example/webhook", content_type: "json", insecure_ssl: "0" };
  const { router, channel } = infra(STORED);
  const ctx = context();
  const keys = router.apps(ctx);
  const planned = await plan([channel], ctx);
  expect(summary(planned.changes)).toEqual([`~ djgrant-claude webhook → ${HOOK}`]);
  expect(calls.every((c) => c.method === "GET" && c.jwtOk)).toBe(true);
  expect(hook.url).toBe("https://old.example/webhook");
  expect(planned.value(keys)).toBe(appsVariable(STORED));

  const applied = await planned.apply();
  expect(hook).toEqual({ url: HOOK, content_type: "json", insecure_ssl: "0", secret: appWebhookSecret(KEY, "4242") });
  expect(applied.value(keys)).toBe(appsVariable(STORED));
});

test("a known channel's webhook follows a new router, whose URL is only known once it's applied", async () => {
  hook = { url: HOOK, content_type: "json", insecure_ssl: "0" };
  const { channel } = infra(STORED, { url: "https://new.example", exists: false });
  const planned = await plan([channel], context());
  expect(summary(planned.changes)).toEqual(["+ router service", "~ djgrant-claude webhook → the router's URL"]);
  await planned.apply();
  expect(hook.url).toBe("https://new.example/webhook");
});

test("an up-to-date channel plans nothing, and what it lacks shows as warnings", async () => {
  hook = { url: HOOK, content_type: "json", insecure_ssl: "0" };
  settings = { events: ["issues", "push"], permissions: { ...PERMISSIONS, actions_variables: "read" } };
  const planned = await plan([infra(STORED).channel], context());
  expect(planned.changes).toEqual([]);
  expect(planned.warnings).toEqual([
    `djgrant-claude doesn't send issue_comment: change it at ${web()}/settings/apps/djgrant-claude/permissions`,
    `djgrant-claude lacks actions_variables: write: change it at ${web()}/settings/apps/djgrant-claude/permissions`,
  ]);
  await planned.apply();
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
});

test("one ACHQ_GITHUB_APPS group per router holds the App of every channel declared on it, even after the group", async () => {
  hook = { url: HOOK, content_type: "json", insecure_ssl: "0" };
  const { router, channel } = infra(STORED);
  const ctx = context();
  expect((await plan([channel], ctx)).value(router.apps(ctx))).toBe(appsVariable(STORED));
  // A new channel, declared after the first made the group: the variable waits on it.
  const later = new Channel("org", { name: "Notation ACHQ", org: "notationlabs", router });
  expect((await plan([channel, later], ctx)).value(router.apps(ctx))).toBe(UNKNOWN);
});

test("two channels with one slug are refused", () => {
  const { router } = infra({});
  expect(() => new Channel("again", { name: "DJGrant Claude", router })).toThrow("Two channels are named djgrant-claude");
});

describe("with a vault", () => {
  const ITEM = "GitHub App djgrant-claude";

  test("a new App's key goes to the vault, and to the router from there", async () => {
    const vault = memoryVault();
    const { router, channel } = infra({});
    const ctx = context([], true, vault);
    const keys = router.apps(ctx);
    const applied = await (await plan([channel], ctx)).apply();
    expect(vault.items.get(ITEM)).toEqual({ app_id: "4242", private_key: pem });
    expect(JSON.parse(applied.value(keys) as string)).toEqual(STORED);
  });

  test("a vault that fails stops up before the router gets the key, saying how to make another", async () => {
    const vault: Vault = { read: async () => undefined, write: async () => Promise.reject(new Error("not signed in")) };
    const { channel } = infra({});
    const planned = await plan([channel], context([], true, vault));
    await expect(planned.apply()).rejects.toThrow(/couldn't keep its key in the vault \(not signed in\)\. Generate a new private key/);
  });

  test("a router without the App's key gets it from the vault, known when planned, with the webhook moved to it and signed with its secret", async () => {
    hook = { url: "https://old-router.example/webhook", content_type: "json", insecure_ssl: "0", secret: "old" };
    const vault = memoryVault(new Map([[ITEM, { app_id: "4242", private_key: pem }]]));
    const { router, channel } = infra({});
    const ctx = context([], false, vault);
    const keys = router.apps(ctx);
    const planned = await plan([channel], ctx);
    expect(summary(planned.changes)).toEqual(["~ djgrant-claude app key from the vault, and its webhook to this router"]);
    expect(planned.value(keys)).toBe(appsVariable(STORED));
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    await planned.apply();
    expect(hook).toEqual({ url: HOOK, content_type: "json", insecure_ssl: "0", secret: appWebhookSecret(KEY, "4242") });
    expect(calls.some((c) => c.path.startsWith("/app-manifests"))).toBe(false);
  });

  test("a key only the router has is refused, never copied into the vault", async () => {
    const vault = memoryVault();
    await expect(plan([infra(STORED).channel], context([], false, vault))).rejects.toThrow(`The router has djgrant-claude's key but the vault doesn't: add it to the vault as "${ITEM}"`);
    expect(vault.items.size).toBe(0);
  });

  test("a router with the vault's key changes nothing", async () => {
    hook = { url: HOOK, content_type: "json", insecure_ssl: "0" };
    const vault = memoryVault(new Map([[ITEM, { app_id: "4242", private_key: pem }]]));
    expect((await plan([infra(STORED).channel], context([], false, vault))).changes).toEqual([]);
  });

  test("a vault's key GitHub turns down is as good as none: the App is made again", async () => {
    const { privateKey: other } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const log: string[] = [];
    const vault = memoryVault(new Map([[ITEM, { app_id: "4242", private_key: other }]]));
    const planned = await plan([infra({}).channel], context(log, true, vault));
    expect(summary(planned.changes)).toEqual(["+ djgrant-claude github channel opens GitHub to create its App"]);
    expect(log).toEqual(["  ! GitHub turned down djgrant-claude's key from the vault (401), so it's made again"]);
    await planned.apply();
    expect(vault.items.get(ITEM)).toEqual({ app_id: "4242", private_key: pem });
  });
});

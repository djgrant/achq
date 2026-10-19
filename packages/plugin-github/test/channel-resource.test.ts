import { afterEach, beforeEach, expect, test } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import {
  type Change,
  type Context,
  type EnvValue,
  type EnvValues,
  ManagedResource,
  Output,
  type Planned,
  plan,
  resetDeclarations,
  Router,
  UNKNOWN,
} from "@achq/core";
import { appsVariable } from "../src/lib/app-keys.ts";
import { appWebhookSecret } from "../src/lib/webhook-secret.ts";
import { Channel } from "../src/resources/channel.ts";

const { privateKey: pem, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const PERMISSIONS = { contents: "write", issues: "write", pull_requests: "write", metadata: "read", actions_variables: "write" };
const ROUTER = "https://router.example";
const HOOK = `${ROUTER}/webhook`;

let gh: ReturnType<typeof Bun.serve>;
let calls: { method: string; path: string; jwtOk: boolean }[];
let hook: { url?: string; content_type?: string; insecure_ssl?: string; secret?: string };
let settings: { events: string[]; permissions: Record<string, string> };

const jwtValid = (auth: string | null) => {
  const [h, p, s] = (auth?.replace(/^Bearer /, "") ?? "").split(".");
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

const context = (log: string[] = [], withOpen = true): Context => ({
  env: { GITHUB_API_URL: web(), GITHUB_WEB_URL: web() },
  log: (line) => log.push(line),
  ...(withOpen && { open }),
  newSecret: () => "secret",
  sleep: async () => {},
});

type Service = { url: string; key: string; env: Record<string, string>; exists: boolean };

/** What the router's URL, key and variables come from. A new one's URL is only known once it's applied. */
class RouterService extends ManagedResource<Service, true, Omit<Service, "exists">, "create"> {
  readonly kind = "service";
  read = async ({ exists }: Service) => (exists ? (true as const) : undefined);
  diff = (_: Service, current: true | undefined) => (current ? [] : ["create" as const]);
  describe = (): Change => ({ op: "+", target: "router" });
  planned = ({ url, key, env }: Service, current: true | undefined): Planned<Omit<Service, "exists">> => ({ url: current ? url : UNKNOWN, key, env });
  apply = async ({ url, key, env }: Service) => ({ url, key, env });
}

/** A router whose variable groups are recorded, not set. */
class StubRouter extends Router {
  readonly containerHost = "stub";
  readonly url: Output<string>;
  readonly key: Output<string>;
  readonly env: Output<Record<string, string>>;
  readonly groups: (EnvValues | ((ctx: Context) => EnvValues))[] = [];

  constructor(service: Service) {
    super("router");
    const s = new RouterService("service", service, { parent: this });
    [this.url, this.key, this.env] = [s.out("url"), s.out("key"), s.out("env")];
  }
  privateUrl = (port: number) => `http://router.internal:${port}`;
  variables(values: EnvValues | ((ctx: Context) => EnvValues)) {
    this.groups.push(values);
    return new Output<Record<string, string>>([], () => ({}));
  }
  /** Its ACHQ_GITHUB_APPS, as the channels declared it. */
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

const summary = (changes: Change[]) => changes.map((c) => `${c.op} ${c.target}${c.detail ? ` ${c.detail}` : ""}`);

test("a channel's comparison is pure: it takes what was read and says what differs", () => {
  const { router } = infra({});
  const channel = new Channel("org", { name: "Notation ACHQ", org: "notationlabs", router });
  const props = { slug: "notation-achq", name: "Notation ACHQ", org: "notationlabs", hookUrl: HOOK, key: KEY };
  expect(channel.slug).toBe("notation-achq");

  const create = channel.diff(props, undefined);
  expect(create.map((c) => channel.describe(c, props))).toEqual([{ op: "+", target: "github channel Notation ACHQ (notationlabs)", detail: "opens GitHub to create its App" }]);
  expect(channel.planned(props, undefined)).toEqual({ slug: UNKNOWN, id: UNKNOWN, privateKey: UNKNOWN });

  const known = { ...props, stored: { id: "1", privateKey: "k" } };
  const settingsUrl = "https://github.com/organizations/notationlabs/settings/apps/notation-achq/permissions";
  const current = { events: ["issues", "push"], permissions: { ...PERMISSIONS, contents: "read" }, hook: { url: HOOK, content_type: "json", insecure_ssl: "0" }, settings: settingsUrl };
  expect(channel.diff(known, current)).toEqual([]);
  expect(channel.planned(known, current)).toEqual({ slug: "notation-achq", id: "1", privateKey: "k" });
  expect(channel.check(known, current)).toEqual([
    `notation-achq doesn't send issue_comment: change it at ${settingsUrl}`,
    `notation-achq lacks contents: write: change it at ${settingsUrl}`,
  ]);

  const drifted = { ...current, hook: { ...current.hook, insecure_ssl: "1" } };
  expect(channel.diff(known, drifted).map((c) => channel.describe(c, known))).toEqual([{ op: "~", target: "notation-achq webhook", detail: `→ ${HOOK}` }]);
  // A new router's URL isn't known yet, so it differs from whatever the webhook has.
  const unknown = { ...known, hookUrl: UNKNOWN as never };
  expect(channel.diff(unknown, current).map((c) => channel.describe(c, unknown))).toEqual([{ op: "~", target: "notation-achq webhook", detail: "→ the router's URL" }]);
});

test("a new channel plans as a create without calling GitHub, then is created with its webhook secret", async () => {
  const log: string[] = [];
  const { router, channel } = infra(OTHER);
  const ctx = context(log);
  const keys = router.apps(ctx);
  const planned = await plan([channel], ctx);
  expect(summary(planned.changes)).toEqual(["+ github channel djgrant-claude opens GitHub to create its App"]);
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
  await expect(planned.apply()).rejects.toThrow("Creating GitHub App djgrant-claude opens your browser, which only `achq up` can do");
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
  expect(summary(planned.changes)).toEqual(["+ router", "~ djgrant-claude webhook → the router's URL"]);
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

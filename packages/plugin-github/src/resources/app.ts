// A GitHub App and its webhook, declared in the ACHQ infra. Its webhooks go to
// the router, and the router mints its tokens. GitHub never gives a private key
// back, so an App achq can act as is one whose key the router keeps: without
// one, it's created through the manifest flow.
import { all, type Change, type Context, known, ManagedResource, type Planned, type Router, UNKNOWN } from "@achq/core";
import { AppRef } from "../channels/app-ref.ts";
import { type AppKeys, appsVariable, parseApps } from "../lib/app-keys.ts";
import { GitHubClient } from "../lib/client.ts";
import { GITHUB_ENV } from "../lib/constants.ts";
import { appJwt } from "../lib/jwt.ts";
import { covers } from "../lib/permissions.ts";
import { githubUrls } from "../lib/urls.ts";
import { appWebhookSecret } from "../lib/webhook-secret.ts";
import { appSlug } from "./app-slug.ts";
import { APP_EVENTS, APP_PERMISSIONS } from "./constants.ts";
import { manifestFlow } from "./manifest.ts";

export type AppInputs = {
  /** The App's name on GitHub, which its slug comes from. */
  name: string;
  /** The organisation that owns it. Without one it's owned by your account and public, so others can install it. */
  org?: string;
  router: Router;
};

export type AppProps = {
  /** What its name makes it, and what the router knows it by. */
  slug: string;
  name: string;
  org?: string;
  /** Where its webhook goes: the router's. Unknown while the router has no public URL. */
  hookUrl: string;
  /** AGENT_WEBHOOK_KEY, which its webhook secret derives from. */
  key: string;
  /** Its ID and key, from the router's ACHQ_GITHUB_APPS, if it exists. */
  stored?: AppKeys[string];
};

export type HookConfig = { url?: string; content_type?: string; insecure_ssl?: string };

/** `settings` is where you change what achq can't. */
export type AppState = { events: string[]; permissions: Record<string, string>; hook: HookConfig; settings: string };

/** The slug is GitHub's, which can differ from the one its name makes. */
export type AppAttrs = { slug: string; id: string; privateKey: string };

export type AppChange = { kind: "create" } | { kind: "webhook" };

/** What the live App lacks of what achq needs. */
export const appProblems = (settings: { events: string[]; permissions: Record<string, string> }) => [
  ...APP_EVENTS.filter((e) => !settings.events.includes(e)).map((e) => `doesn't send ${e}`),
  ...Object.entries(APP_PERMISSIONS)
    .filter(([name, level]) => !covers(settings.permissions[name], level))
    .map(([name, level]) => `lacks ${name}: ${level}`),
];

export const appSettingsUrl = (slug: string, org: string | undefined, web: string) =>
  org ? `${web}/organizations/${org}/settings/apps/${slug}/permissions` : `${web}/settings/apps/${slug}/permissions`;

const hookConfig = (url: string, key: string, appId: string | number) => ({
  url,
  content_type: "json",
  insecure_ssl: "0",
  secret: appWebhookSecret(key, appId),
});

/** The webhook as wanted. The secret isn't compared: GitHub doesn't show it, so it's written with every change. */
const hookDiffers = (hookUrl: string, hook: HookConfig) =>
  !known(hookUrl) || hook.url !== hookUrl || hook.content_type !== "json" || hook.insecure_ssl !== "0";

const asApp = (api: string, id: string | number, privateKey: string) => new GitHubClient(`Bearer ${appJwt(id, privateKey)}`, api);

/** Each router's Apps, by slug. */
const routerApps = new WeakMap<Router, Map<string, App>>();

/**
 * The router's ACHQ_GITHUB_APPS: every App declared on it, so it's declared
 * once, as a function, when the router is planned. Keys of Apps no longer
 * declared stay: removing an App from the infra doesn't delete it on GitHub.
 */
const declareKeys = (router: Router, apps: Map<string, App>) =>
  router.variables(() => ({
    [GITHUB_ENV.apps]: all([router.env, all([...apps.values()].map((app) => app.outputs()))]).map(([env, created]) =>
      appsVariable({ ...parseApps(env[GITHUB_ENV.apps]), ...Object.fromEntries(created.map(({ slug, id, privateKey }) => [slug, { id, privateKey }])) }),
    ),
  }));

export class App extends ManagedResource<AppProps, AppState, AppAttrs, AppChange> {
  readonly kind = "github-app";
  readonly slug: string;

  constructor(
    name: string,
    readonly inputs: AppInputs,
  ) {
    const { router } = inputs;
    const slug = appSlug(inputs.name);
    super(name, {
      slug,
      name: inputs.name,
      org: inputs.org,
      hookUrl: router.url.map((url) => `${url}/webhook`),
      key: router.key,
      stored: router.env.map((env) => parseApps(env[GITHUB_ENV.apps])[slug]),
    });
    this.slug = slug;
    let apps = routerApps.get(router);
    if (!apps) {
      routerApps.set(router, (apps = new Map()));
      declareKeys(router, apps);
    }
    if (apps.has(slug)) throw new Error(`Two Apps are named ${slug}`);
    apps.set(slug, this);
  }

  /** Adopts an App declared in the ACHQ infra, by its slug. */
  static get(slug: string) {
    return new AppRef(slug);
  }

  async read({ slug, org, stored }: AppProps, ctx: Context): Promise<AppState | undefined> {
    if (!stored) return undefined;
    const { api, web } = githubUrls(ctx.env);
    const client = asApp(api, stored.id, stored.privateKey);
    const [settings, hook] = await Promise.all([
      client.request<{ events: string[]; permissions: Record<string, string> }>("GET", "/app"),
      client.request<HookConfig>("GET", "/app/hook/config"),
    ]);
    return { events: settings.events, permissions: settings.permissions, hook, settings: appSettingsUrl(slug, org, web) };
  }

  diff({ hookUrl }: AppProps, current: AppState | undefined): AppChange[] {
    return !current ? [{ kind: "create" }] : hookDiffers(hookUrl, current.hook) ? [{ kind: "webhook" }] : [];
  }

  describe(change: AppChange, { slug, name, org, hookUrl }: AppProps): Change {
    switch (change.kind) {
      case "create":
        return { op: "+", target: `github app ${name}${org ? ` (${org})` : ""}`, detail: "opens GitHub to create it" };
      case "webhook":
        return { op: "~", target: `${slug} webhook`, detail: `→ ${known(hookUrl) ? hookUrl : "the router's URL"}` };
    }
  }

  check({ slug }: AppProps, current: AppState) {
    return appProblems(current).map((problem) => `${slug} ${problem}: change it at ${current.settings}`);
  }

  planned({ slug, stored }: AppProps, current: AppState | undefined): Planned<AppAttrs> {
    return current && stored ? { slug, ...stored } : { slug: UNKNOWN, id: UNKNOWN, privateKey: UNKNOWN };
  }

  async apply({ slug, name, org, hookUrl, key, stored }: AppProps, _: AppState | undefined, changes: AppChange[], ctx: Context): Promise<AppAttrs> {
    const { api, web } = githubUrls(ctx.env);
    if (changes.some((c) => c.kind === "webhook")) {
      await asApp(api, stored!.id, stored!.privateKey).request("PATCH", "/app/hook/config", hookConfig(hookUrl, key, stored!.id));
      return { slug, ...stored! };
    }
    const open = ctx.open;
    if (!open) throw new Error(`Creating GitHub App ${name} opens your browser, which only \`achq up\` can do`);
    const created = await manifestFlow({ name, org, hookUrl }, { open: (url) => open(url, `create ${name} on GitHub`), githubApi: api, githubWeb: web });
    // The secret derives from the App ID, which GitHub only assigns on creation.
    await asApp(api, created.id, created.pem).request("PATCH", "/app/hook/config", hookConfig(hookUrl, key, created.id));
    if (created.slug !== slug) ctx.log(`  ! GitHub named it ${created.slug}: set the App's name to "${created.slug}" in the infra`);
    ctx.log(`  created ${created.html_url}`);
    return { slug: created.slug, id: String(created.id), privateKey: created.pem };
  }
}

// A channel, declared in the ACHQ infra: a GitHub App and its webhook. Its
// webhooks go to the router, and the router mints its tokens. GitHub never
// gives a private key back, so an App achq can act as is one whose key the
// router keeps: without one, it's created through the manifest flow.
import { all, type Change, type Context, known, ManagedResource, type Planned, type Router, UNKNOWN } from "@achq/core";
import { type AppKeys, appJwt, appsVariable, appWebhookSecret, parseApps } from "../lib/apps.ts";
import { GitHubClient, githubUrls } from "../lib/client.ts";
import { GITHUB_ENV } from "../lib/constants.ts";
import { appSlug, manifestFlow } from "../lib/manifest.ts";
import { APP_EVENTS, APP_PERMISSIONS, covers } from "../lib/permissions.ts";
import { ChannelRef } from "./config.ts";

export type ChannelInputs = {
  /** The App's name on GitHub, which its slug comes from. */
  name: string;
  /** The organisation that owns it. Without one it's owned by your account and public, so others can install it. */
  org?: string;
  router: Router;
};

export type ChannelProps = {
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
export type ChannelState = { events: string[]; permissions: Record<string, string>; hook: HookConfig; settings: string };

/** The slug is GitHub's, which can differ from the one its name makes. */
export type ChannelAttrs = { slug: string; id: string; privateKey: string };

export type ChannelChange = { kind: "create" } | { kind: "webhook" };

/** What the live App lacks of what achq needs. */
const appProblems = (settings: { events: string[]; permissions: Record<string, string> }) => [
  ...APP_EVENTS.filter((e) => !settings.events.includes(e)).map((e) => `doesn't send ${e}`),
  ...Object.entries(APP_PERMISSIONS)
    .filter(([name, level]) => !covers(settings.permissions[name], level))
    .map(([name, level]) => `lacks ${name}: ${level}`),
];

const appSettingsUrl = (slug: string, org: string | undefined, web: string) =>
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

/** Each router's channels, by slug. */
const routerChannels = new WeakMap<Router, Map<string, Channel>>();

/**
 * The router's ACHQ_GITHUB_APPS: the App of every channel declared on it, so
 * it's declared once, as a function, when the router is planned. Keys of Apps
 * no longer declared stay: removing a channel from the infra doesn't delete its
 * App on GitHub.
 */
const declareKeys = (router: Router, channels: Map<string, Channel>) =>
  router.variables(() => ({
    [GITHUB_ENV.apps]: all([router.env, all([...channels.values()].map((channel) => channel.outputs()))]).map(([env, created]) =>
      appsVariable({ ...parseApps(env[GITHUB_ENV.apps]), ...Object.fromEntries(created.map(({ slug, id, privateKey }) => [slug, { id, privateKey }])) }),
    ),
  }));

export class Channel extends ManagedResource<ChannelProps, ChannelState, ChannelAttrs, ChannelChange> {
  readonly kind = "github-channel";
  readonly slug: string;

  constructor(
    name: string,
    readonly inputs: ChannelInputs,
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
    let channels = routerChannels.get(router);
    if (!channels) {
      routerChannels.set(router, (channels = new Map()));
      declareKeys(router, channels);
    }
    if (channels.has(slug)) throw new Error(`Two channels are named ${slug}`);
    channels.set(slug, this);
  }

  /** Adopts a channel declared in the ACHQ infra, by its App's slug. */
  static get(slug: string) {
    return new ChannelRef(slug);
  }

  async read({ slug, org, stored }: ChannelProps, ctx: Context): Promise<ChannelState | undefined> {
    if (!stored) return undefined;
    const { api, web } = githubUrls(ctx.env);
    const client = asApp(api, stored.id, stored.privateKey);
    const [settings, hook] = await Promise.all([
      client.request<{ events: string[]; permissions: Record<string, string> }>("GET", "/app"),
      client.request<HookConfig>("GET", "/app/hook/config"),
    ]);
    return { events: settings.events, permissions: settings.permissions, hook, settings: appSettingsUrl(slug, org, web) };
  }

  diff({ hookUrl }: ChannelProps, current: ChannelState | undefined): ChannelChange[] {
    return !current ? [{ kind: "create" }] : hookDiffers(hookUrl, current.hook) ? [{ kind: "webhook" }] : [];
  }

  describe(change: ChannelChange, { slug, name, org, hookUrl }: ChannelProps): Change {
    switch (change.kind) {
      case "create":
        return { op: "+", target: `github channel ${name}${org ? ` (${org})` : ""}`, detail: "opens GitHub to create its App" };
      case "webhook":
        return { op: "~", target: `${slug} webhook`, detail: `→ ${known(hookUrl) ? hookUrl : "the router's URL"}` };
    }
  }

  check({ slug }: ChannelProps, current: ChannelState) {
    return appProblems(current).map((problem) => `${slug} ${problem}: change it at ${current.settings}`);
  }

  planned({ slug, stored }: ChannelProps, current: ChannelState | undefined): Planned<ChannelAttrs> {
    return current && stored ? { slug, ...stored } : { slug: UNKNOWN, id: UNKNOWN, privateKey: UNKNOWN };
  }

  async apply({ slug, name, org, hookUrl, key, stored }: ChannelProps, _: ChannelState | undefined, changes: ChannelChange[], ctx: Context): Promise<ChannelAttrs> {
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

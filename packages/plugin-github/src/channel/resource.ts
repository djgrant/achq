import { all, type Change, type Context, known, ManagedResource, type Planned, type Router, UNKNOWN } from "@achq/core";
import { type AppSettings, GitHub, type HookConfig } from "@achq/utils/gh";
import { type AppKeys, appsVariable, appWebhookSecret, parseApps, vaultedApp } from "../lib/apps.ts";
import { GITHUB_ENV, githubUrls } from "../lib/constants.ts";
import { appSlug, manifestFlow } from "../lib/manifest.ts";
import { APP_EVENTS, APP_PERMISSIONS, lacking } from "../lib/permissions.ts";
import { ChannelRef } from "./config.ts";

export type ChannelInputs = {
  name: string;
  /** Without one it's owned by your account and public, so others can install it. */
  org?: string;
  router: Router;
};

export type ChannelProps = {
  slug: string;
  name: string;
  org?: string;
  /** Unknown while the router has no public URL. */
  hookUrl: string;
  /** AGENT_WEBHOOK_KEY, which its webhook secret derives from. */
  key: string;
  /** Its ID and key, from the router's ACHQ_GITHUB_APPS, if it exists. */
  stored?: AppKeys[string];
};

/**
 * `settings` is where you change what achq can't. `keys` are the App's: the
 * vault's when there's a vault, else the router's. `onRouter` is whether the
 * router has them as they are. `vaulted` is whether they're the vault's.
 */
export type ChannelState = AppSettings & { hook: HookConfig; settings: string; keys: AppKeys[string]; onRouter: boolean; vaulted: boolean };

/** The slug is GitHub's, which can differ from the one its name makes. */
export type ChannelAttrs = { slug: string; id: string; privateKey: string };

/** `restore`: the router gets the App's key from the vault. */
export type ChannelChange = { kind: "create" } | { kind: "webhook" } | { kind: "restore" };

/** GitHub's answer to a JWT signed with a key it doesn't take, or for an App that's gone. */
const TURNED_DOWN = [401, 404];

const WANTED_HOOK = { content_type: "json", insecure_ssl: "0" } as const;

const hookConfig = (url: string, key: string, appId: string | number): HookConfig => ({
  url,
  ...WANTED_HOOK,
  secret: appWebhookSecret(key, appId),
});

const routerChannels = new WeakMap<Router, Map<string, Channel>>();

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
    const channels = routerChannels.get(router) ?? new Map<string, Channel>();
    if (!routerChannels.has(router)) {
      routerChannels.set(router, channels);
      // The router's ACHQ_GITHUB_APPS: the App of every channel declared on it, so
      // it's declared once, as a function, when the router is planned. Keys of Apps
      // no longer declared stay: removing a channel from the infra doesn't delete its
      // App on GitHub.
      router.variables(() => ({
        [GITHUB_ENV.apps]: all([router.env, all([...channels.values()].map((channel) => channel.outputs()))]).map(([env, apps]) => {
          const declared = Object.fromEntries(apps.map((app) => [app.slug, { id: app.id, privateKey: app.privateKey }]));
          return appsVariable({ ...parseApps(env[GITHUB_ENV.apps]), ...declared });
        }),
      }));
    }
    if (channels.has(slug)) throw new Error(`Two channels are named ${slug}`);
    channels.set(slug, this);
  }

  static get(slug: string) {
    return new ChannelRef(slug);
  }

  /**
   * The App as its key reaches it. With a vault, the key is the vault's, and a
   * router is only ever given it from there, so an App made for one router can
   * be given to another; a key only the router has is refused, never copied
   * into the vault. A vault's key GitHub turns down is as good as none. Without
   * a vault, it's the router's.
   */
  async read({ slug, org, stored }: ChannelProps, ctx: Context): Promise<ChannelState | undefined> {
    const vaulted = ctx.vault ? vaultedApp.keys(await ctx.vault.read(vaultedApp.item(slug))) : undefined;
    if (ctx.vault && !vaulted && stored) {
      throw new Error(`The router has ${slug}'s key but the vault doesn't: add it to the vault as "${vaultedApp.item(slug)}" (fields app_id, private_key), or delete the App`);
    }
    const keys = ctx.vault ? vaulted : stored;
    if (!keys) return undefined;
    const { api, web } = githubUrls(ctx.env);
    const app = GitHub.connectAsApp(keys.id, keys.privateKey, { baseUrl: api });
    let settings: AppSettings, hook: HookConfig;
    try {
      [settings, hook] = await Promise.all([app.app(), app.hookConfig()]);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (!ctx.vault || !TURNED_DOWN.includes(status!)) throw e;
      ctx.log(`  ! GitHub turned down ${slug}'s key from the vault (${status}), so it's made again`);
      return undefined;
    }
    const permissionsPage = org ? `${web}/organizations/${org}/settings/apps/${slug}/permissions` : `${web}/settings/apps/${slug}/permissions`;
    return {
      events: settings.events,
      permissions: settings.permissions,
      hook,
      settings: permissionsPage,
      keys,
      onRouter: stored?.id === keys.id && stored.privateKey === keys.privateKey,
      vaulted: Boolean(ctx.vault),
    };
  }

  diff({ hookUrl }: ChannelProps, current: ChannelState | undefined): ChannelChange[] {
    if (!current) return [{ kind: "create" }];
    // A router given the key from the vault has its own webhook secret, so the webhook is written with it.
    if (!current.onRouter) return [{ kind: "restore" }];
    // The secret isn't compared: GitHub doesn't show it, so it's written with every change.
    const { hook } = current;
    const differs = !known(hookUrl) || hook.url !== hookUrl || hook.content_type !== WANTED_HOOK.content_type || hook.insecure_ssl !== WANTED_HOOK.insecure_ssl;
    return differs ? [{ kind: "webhook" }] : [];
  }

  describe(change: ChannelChange, { slug, name, org, hookUrl }: ChannelProps): Change {
    switch (change.kind) {
      case "create":
        return { op: "+", target: `${name}${org ? ` (${org})` : ""}`, what: "github channel", detail: "opens GitHub to create its App" };
      case "webhook":
        return { op: "~", target: slug, what: "webhook", detail: `→ ${known(hookUrl) ? hookUrl : "the router's URL"}` };
      case "restore":
        return { op: "~", target: slug, what: "app key", detail: "from the vault, and its webhook to this router" };
    }
  }

  check({ slug }: ChannelProps, current: ChannelState) {
    const lacks = lacking(current, { events: APP_EVENTS, permissions: APP_PERMISSIONS });
    const problems = [...lacks.events.map((e) => `doesn't send ${e}`), ...lacks.permissions.map(([name, level]) => `lacks ${name}: ${level}`)];
    return problems.map((problem) => `${slug} ${problem}: change it at ${current.settings}`);
  }

  /** GitHub has no API to delete an App. With a vault, its key is kept there for the next router; without one, it goes with the router. */
  kept({ slug }: ChannelProps, current: ChannelState) {
    const page = current.settings.replace(/\/permissions$/, "/advanced");
    return !current.vaulted
      ? `GitHub App ${slug}: its key goes with the router, so the next \`achq infra up\` makes another. Delete it at ${page}`
      : `GitHub App ${slug}, whose key the vault keeps for the next router. To be done with it, delete it at ${page}, and its key from the vault`;
  }

  planned({ slug }: ChannelProps, current: ChannelState | undefined): Planned<ChannelAttrs> {
    return current ? { slug, ...current.keys } : { slug: UNKNOWN, id: UNKNOWN, privateKey: UNKNOWN };
  }

  async apply({ slug, name, org, hookUrl, key }: ChannelProps, current: ChannelState | undefined, changes: ChannelChange[], ctx: Context): Promise<ChannelAttrs> {
    const { api, web } = githubUrls(ctx.env);
    if (current) {
      const { keys } = current;
      if (changes.some((c) => c.kind === "webhook" || c.kind === "restore")) {
        await GitHub.connectAsApp(keys.id, keys.privateKey, { baseUrl: api }).setHookConfig(hookConfig(hookUrl, key, keys.id));
      }
      return { slug, ...keys };
    }
    const open = ctx.open;
    if (!open) throw new Error(`Creating GitHub App ${name} opens your browser, which only \`achq infra up\` can do`);
    const created = await manifestFlow({ name, org, hookUrl }, { open: (url) => open(url, `create ${name} on GitHub`), githubApi: api, githubWeb: web });
    const made = { slug: created.slug ?? slug, id: String(created.id), privateKey: created.pem };
    // The vault is where the key lives; the router only gets it from there. GitHub shows the key once, so failing here says how to make another.
    await ctx.vault?.write(vaultedApp.item(made.slug), vaultedApp.fields(made)).catch((e: Error) => {
      throw new Error(`Created ${created.html_url}, but couldn't keep its key in the vault (${e.message}). Generate a new private key on the App's page, add it to the vault as "${vaultedApp.item(made.slug)}" (fields app_id, private_key), then run \`achq infra up\` again`);
    });
    // The secret derives from the App ID, which GitHub only assigns on creation.
    await GitHub.connectAsApp(String(created.id), created.pem, { baseUrl: api }).setHookConfig(hookConfig(hookUrl, key, created.id));
    if (created.slug !== slug) ctx.log(`  ! GitHub named it ${created.slug}: set the App's name to "${created.slug}" in the infra`);
    ctx.log(`  created ${created.html_url}`);
    return made;
  }
}

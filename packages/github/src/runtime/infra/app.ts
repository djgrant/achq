// An App keeps its own credential: GitHub only hands over the private key when
// the App is created, so creating one and storing its key are one step.
import { githubAppVariable, type SecretLocation, type SecretRef, type SecretStore } from "@achq/core";
import { appWebhookSecret, secretDigest } from "@achq/core/secrets";
import type { Provider } from "@achq/reconcile";
import { GitHubClient } from "../../api/client.ts";
import { appJwt } from "../../api/jwt.ts";
import { APP_EVENTS, APP_PERMISSIONS, GITHUB_API, GITHUB_WEB } from "../../constants.ts";
import { parseAppCredential } from "../app-keys.ts";
import { covers } from "../permissions.ts";
import { appSlug } from "./app-slug.ts";

/** Creates an App through GitHub's manifest flow, in a browser. */
export type CreateApp = (request: { name: string; org?: string; hookUrl: string }) => Promise<{ id: number; slug: string; pem: string; html_url: string }>;

export type AppDeps = { createApp: CreateApp; api?: string };

export type AppParams = {
  name: string;
  org?: string;
  hookUrl: string;
  /** Where its credential is. */
  location: "store";
  store: SecretStore;
  /** AGENT_WEBHOOK_KEY, which the App's webhook secret derives from. */
  key: SecretRef;
};

export type LiveApp = { name: string; org?: string; hookUrl?: string; location: SecretLocation; slug: string; id: string; credential: SecretRef; problems: string[] };

type HookConfig = { url?: string; content_type?: string; insecure_ssl?: string };
type AppSettings = { events: string[]; permissions: Record<string, string>; owner?: { login: string; type: string } };

/** What the live App lacks of what achq needs. */
export const appProblems = (settings: Pick<AppSettings, "events" | "permissions">) => [
  ...APP_EVENTS.filter((e) => !settings.events.includes(e)).map((e) => `doesn't send ${e}`),
  ...Object.entries(APP_PERMISSIONS)
    .filter(([name, level]) => !covers(settings.permissions[name], level))
    .map(([name, level]) => `lacks ${name}: ${level}`),
];

const settingsUrl = (slug: string, org?: string) =>
  org ? `${GITHUB_WEB}/organizations/${org}/settings/apps/${slug}/permissions` : `${GITHUB_WEB}/settings/apps/${slug}/permissions`;

export const githubApp = (deps: AppDeps): Provider<AppParams, LiveApp> => {
  const asApp = (id: string, privateKey: string) => new GitHubClient(`Bearer ${appJwt(id, privateKey)}`, deps.api ?? GITHUB_API);
  const credentialOf = (store: SecretStore, variable: string) => store.read(variable).then((found) => parseAppCredential(variable, found!.value));
  const refOf = (store: SecretStore, variable: string, value: string): SecretRef => ({ name: variable, ref: store.ref(variable), digest: secretDigest(value) });
  // GitHub doesn't show the secret, so it's written with the URL rather than compared.
  const writeHook = async (p: AppParams, id: string, privateKey: string) => {
    const key = (await p.store.read(p.key.name))!.value;
    await asApp(id, privateKey).request("PATCH", "/app/hook/config", { url: p.hookUrl, content_type: "json", insecure_ssl: "0", secret: appWebhookSecret(key, id) });
  };

  return {
    schema: { name: { kind: "key" }, org: { kind: "param", immutable: true }, hookUrl: { kind: "param" }, location: { kind: "param" } },
    read: async (p) => {
      const variable = githubAppVariable(appSlug(p.name));
      const found = await p.store.read(variable);
      if (!found) return undefined;
      const { slug, id, privateKey } = parseAppCredential(variable, found.value);
      const client = asApp(id, privateKey);
      const [hook, settings] = await Promise.all([client.request<HookConfig>("GET", "/app/hook/config"), client.request<AppSettings>("GET", "/app")]);
      const owner = settings.owner?.type === "Organization" ? settings.owner.login : undefined;
      return {
        name: p.name,
        // Logins aren't case-sensitive.
        org: owner && p.org && owner.toLowerCase() === p.org.toLowerCase() ? p.org : owner,
        // A webhook that isn't JSON over verified TLS needs setting again, wherever it points.
        hookUrl: hook.content_type === "json" && hook.insecure_ssl === "0" ? hook.url : undefined,
        location: found.location,
        slug,
        id,
        credential: refOf(p.store, variable, found.value),
        problems: appProblems(settings),
      };
    },
    create: async (p) => {
      const created = await deps.createApp({ name: p.name, org: p.org, hookUrl: p.hookUrl });
      const id = String(created.id);
      const variable = githubAppVariable(created.slug);
      const value = JSON.stringify({ slug: created.slug, id, privateKey: created.pem });
      await p.store.write(variable, value);
      // The webhook secret derives from the App ID, which GitHub only assigns now.
      await writeHook(p, id, created.pem);
      return { name: p.name, org: p.org, hookUrl: p.hookUrl, location: "store", slug: created.slug, id, credential: refOf(p.store, variable, value), problems: [] };
    },
    update: async (p, current, changed) => {
      const fields = new Set(changed.map((c) => c.field));
      const { name: variable } = current.credential;
      if (fields.has("location")) await p.store.write(variable, (await p.store.read(variable))!.value);
      if (fields.has("hookUrl")) await writeHook(p, current.id, (await credentialOf(p.store, variable)).privateKey);
      return { ...current, hookUrl: p.hookUrl, location: "store" };
    },
    notes: (p, app) => [
      ...(app.slug !== appSlug(p.name) ? [`GitHub named ${p.name} ${app.slug}: set its name to "${app.slug}" in the infra`] : []),
      ...app.problems.map((problem) => `${app.slug} ${problem}: change it at ${settingsUrl(app.slug, p.org)}`),
    ],
  };
};

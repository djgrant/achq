import type { Change, InfraStep } from "@achq/core";
import { GitHubClient } from "../api/client.ts";
import { appJwt } from "../api/jwt.ts";
import { APP_EVENTS, APP_PERMISSIONS } from "../constants.ts";
import type { App } from "../resources/app.ts";
import type { AppKeys } from "../runtime/app-keys.ts";
import { covers } from "../runtime/permissions.ts";
import { appWebhookSecret } from "../runtime/webhook-secret.ts";
import { appSlug } from "./app-slug.ts";
import { manifestFlow } from "./manifest.ts";

/** Creates missing Apps (into `keys`) and points every App's webhook at the router. */
export const syncApps = async (apps: App[], keys: AppKeys, step: InfraStep, urls: { api: string; web: string }) => {
  const { hookUrl, key, dryRun, log } = step;
  for (const app of apps) {
    const slug = appSlug(app.inputs.name);
    const known = keys[slug];
    if (!known) {
      log(`  + github app ${app.inputs.name}${app.inputs.org ? ` (${app.inputs.org})` : ""}: opens GitHub to create it`);
      if (dryRun) continue;
      const created = await manifestFlow(
        { name: app.inputs.name, org: app.inputs.org, hookUrl: hookUrl! },
        { open: (url) => step.open(url, `create ${app.inputs.name} on GitHub`), githubApi: urls.api, githubWeb: urls.web },
      );
      const client = new GitHubClient(`Bearer ${appJwt(created.id, created.pem)}`, urls.api);
      // The secret derives from the App ID, which GitHub only assigns on creation.
      await client.request("PATCH", "/app/hook/config", hookConfig(hookUrl!, key, created.id));
      keys[created.slug] = { id: String(created.id), privateKey: created.pem };
      if (created.slug !== slug) log(`  ! GitHub named it ${created.slug}: set the App's name to "${created.slug}" in the infra`);
      log(`  created ${created.html_url}`);
      continue;
    }
    const client = new GitHubClient(`Bearer ${appJwt(known.id, known.privateKey)}`, urls.api);
    const [config, settings] = await Promise.all([
      client.request<{ url?: string; content_type?: string; insecure_ssl?: string }>("GET", "/app/hook/config"),
      client.request<{ events: string[]; permissions: Record<string, string> }>("GET", "/app"),
    ]);
    const changes: Change[] = [];
    if (hookUrl && (config.url !== hookUrl || config.content_type !== "json" || config.insecure_ssl !== "0")) {
      changes.push({ op: "~", target: `${slug} webhook`, detail: `→ ${hookUrl}` });
    }
    step.show(slug, changes);
    for (const problem of appProblems(settings)) log(`  ! ${slug} ${problem}: change it at ${appSettingsUrl(slug, app, urls.web)}`);
    // GitHub doesn't show the secret, so it's written with the URL rather than compared.
    if (!dryRun && changes.length) await client.request("PATCH", "/app/hook/config", hookConfig(hookUrl!, key, known.id));
  }
};

const hookConfig = (url: string, key: string, appId: string | number) => ({
  url,
  content_type: "json",
  insecure_ssl: "0",
  secret: appWebhookSecret(key, appId),
});

/** What the live App lacks of what achq needs. */
export const appProblems = (settings: { events: string[]; permissions: Record<string, string> }) => [
  ...APP_EVENTS.filter((e) => !settings.events.includes(e)).map((e) => `doesn't send ${e}`),
  ...Object.entries(APP_PERMISSIONS)
    .filter(([name, level]) => !covers(settings.permissions[name], level))
    .map(([name, level]) => `lacks ${name}: ${level}`),
];

const appSettingsUrl = (slug: string, app: App, web: string) =>
  app.inputs.org ? `${web}/organizations/${app.inputs.org}/settings/apps/${slug}/permissions` : `${web}/settings/apps/${slug}/permissions`;

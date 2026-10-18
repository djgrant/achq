import type { Change } from "@achq/core";
import { appWebhookSecret } from "@achq/core/secrets";
import type { App } from "@achq/github";
import { appJwt, GitHubClient } from "@achq/github/api";
import { covers } from "@achq/github/runtime";
import { APP_EVENTS, APP_PERMISSIONS, GITHUB_WEB } from "../../constants.ts";
import { appSlug } from "../app-slug.ts";
import type { CreatedApp, ManifestRequest } from "../manifest.ts";
import { showChanges } from "./format.ts";

/** Each App's ID and private key, by slug: the router's ACHQ_GITHUB_APPS. */
export type AppKeys = Record<string, { id: string; privateKey: string }>;

export type AppsStep = {
  /** Read from the router's variables. Created Apps' keys are added to it. */
  keys: AppKeys;
  /** Unknown until the router has a domain. */
  hookUrl?: string;
  /** AGENT_WEBHOOK_KEY, which each App's webhook secret derives from. */
  key: string;
  githubApi: string;
  dryRun: boolean;
  createApp: (request: ManifestRequest) => Promise<CreatedApp>;
  log: (line: string) => void;
};

/** Creates missing Apps and points every App's webhook at the router. Returns whether any App was created. */
export const syncApps = async (apps: App[], step: AppsStep) => {
  const { keys: known, hookUrl, key, githubApi, dryRun, log } = step;
  let added = false;
  for (const app of apps) {
    const slug = appSlug(app.inputs.name);
    const keys = known[slug];
    if (!keys) {
      log(`  + github app ${app.inputs.name}${app.inputs.org ? ` (${app.inputs.org})` : ""}: opens GitHub to create it`);
      if (dryRun) continue;
      const created = await step.createApp({ name: app.inputs.name, org: app.inputs.org, hookUrl: hookUrl! });
      const client = new GitHubClient(`Bearer ${appJwt(created.id, created.pem)}`, githubApi);
      // The secret derives from the App ID, which GitHub only assigns on creation.
      await client.request("PATCH", "/app/hook/config", hookConfig(hookUrl!, key, created.id));
      known[created.slug] = { id: String(created.id), privateKey: created.pem };
      added = true;
      if (created.slug !== slug) log(`  ! GitHub named it ${created.slug}: set the App's name to "${created.slug}" in the infra`);
      log(`  created ${created.html_url}`);
      continue;
    }
    const client = new GitHubClient(`Bearer ${appJwt(keys.id, keys.privateKey)}`, githubApi);
    const [config, settings] = await Promise.all([
      client.request<{ url?: string; content_type?: string; insecure_ssl?: string }>("GET", "/app/hook/config"),
      client.request<{ events: string[]; permissions: Record<string, string> }>("GET", "/app"),
    ]);
    const changes: Change[] = [];
    if (hookUrl && (config.url !== hookUrl || config.content_type !== "json" || config.insecure_ssl !== "0")) {
      changes.push({ op: "~", target: `${slug} webhook`, detail: `→ ${hookUrl}` });
    }
    showChanges(log, slug, changes);
    for (const problem of appProblems(settings)) log(`  ! ${slug} ${problem}: change it at ${appSettingsUrl(slug, app)}`);
    // GitHub doesn't show the secret, so it's written with the URL rather than compared.
    if (!dryRun && changes.length) await client.request("PATCH", "/app/hook/config", hookConfig(hookUrl!, key, keys.id));
  }
  return added;
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

const appSettingsUrl = (slug: string, app: App) =>
  app.inputs.org ? `${GITHUB_WEB}/organizations/${app.inputs.org}/settings/apps/${slug}/permissions` : `${GITHUB_WEB}/settings/apps/${slug}/permissions`;

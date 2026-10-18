// Loaded by the router and the container, never the config sandbox.
import type { Installation, SourceSettings } from "@achq/core";
import { GITHUB_API, GitHubClient } from "../api.ts";
import { GitHubAccess } from "./access.ts";
import { type AppKeys, Apps } from "./apps.ts";
import { GitHubChannel } from "./channel.ts";
import { CHANNEL } from "../resources.ts";

export type GitHubOptions = {
  /** Router only: `{ [slug]: { id, privateKey } }`, from ENV.githubApps. */
  apps?: AppKeys;
  /** Router only: AGENT_WEBHOOK_KEY, which each App's webhook secret derives from. */
  key?: string;
  /** For tests: a fake GitHub API. */
  baseUrl?: string;
};

/**
 * The router passes `apps` and `key`. The container passes neither, and only
 * uses `channel.client`, `channel.match*` and `access.install`.
 */
export const createGitHub = (options: GitHubOptions = {}) => {
  const apps = new Apps(options.apps ?? {}, options.baseUrl ?? GITHUB_API);
  const channel = new GitHubChannel(apps, options.key);
  const access = new GitHubAccess(apps);

  /** Every repo each App is installed on, skipping suspended installations (they can't mint tokens). */
  const installations = async (): Promise<Installation[]> => {
    const out: Installation[] = [];
    for (const slug of apps.slugs()) {
      const list = await apps.asApp(slug).paginate<{ id: number; suspended_at?: string | null }>("/app/installations");
      for (const installation of list) {
        if (installation.suspended_at) continue;
        const token = await apps.token(slug, installation.id, { permissions: { metadata: "read" } });
        const repos = await new GitHubClient(`token ${token.token}`, apps.baseUrl).paginate<{ full_name: string }>(
          "/installation/repositories",
          (page) => page.repositories,
        );
        for (const r of repos) out.push({ provider: CHANNEL, source: slug, repo: r.full_name });
      }
    }
    return out;
  };

  /** What each App is set up to send and allow, read as the App. */
  const sources = async (): Promise<SourceSettings[]> =>
    Promise.all(
      apps.slugs().map(async (slug) => {
        const app = await apps.asApp(slug).request<{ events?: string[]; permissions?: Record<string, string> }>("GET", "/app");
        return { channel: CHANNEL, source: slug, events: app.events ?? [], permissions: app.permissions ?? {} };
      }),
    );

  return { channel, access, installations, sources };
};

/** Reads ENV.githubApps' JSON. */
export const parseApps = (json: string | undefined): AppKeys => {
  if (!json) return {};
  const parsed = JSON.parse(json);
  for (const [slug, app] of Object.entries<any>(parsed)) {
    if (!app || typeof app.privateKey !== "string" || (typeof app.id !== "string" && typeof app.id !== "number")) {
      throw new Error(`GitHub App "${slug}" needs an id and a privateKey`);
    }
  }
  return Object.fromEntries(Object.entries<any>(parsed).map(([slug, a]) => [slug, { id: String(a.id), privateKey: a.privateKey }]));
};

export { GitHubAccess, gitConfig } from "./access.ts";
export { Apps, type AppKeys } from "./apps.ts";
export { GitHubChannel, GitHubChannelClient, matchEvent, matchThread, messageId, parseEvent, PUSH_COMMIT_CAP, TRUSTED } from "./channel.ts";

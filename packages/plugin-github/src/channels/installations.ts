import type { Installation, SourceSettings } from "@achq/core";
import { GitHubClient } from "../lib/client.ts";
import { CHANNEL, REPO_HOST } from "../lib/constants.ts";
import type { Apps } from "../lib/apps.ts";

/** Every repo each App is installed on, skipping suspended installations (they can't mint tokens). */
export const installations = async (apps: Apps): Promise<Installation[]> => {
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
      for (const r of repos) out.push({ channel: CHANNEL, source: slug, repo: r.full_name, host: REPO_HOST });
    }
  }
  return out;
};

/** What each App is set up to send and allow, read as the App. */
export const sources = async (apps: Apps): Promise<SourceSettings[]> =>
  Promise.all(
    apps.slugs().map(async (slug) => {
      const app = await apps.asApp(slug).request<{ events?: string[]; permissions?: Record<string, string> }>("GET", "/app");
      return { channel: CHANNEL, source: slug, events: app.events ?? [], permissions: app.permissions ?? {} };
    }),
  );

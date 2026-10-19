import type { Installation as CoreInstallation, InstallationProvider, RepoManifest } from "@achq/core";
import type { Apps } from "../lib/apps.ts";
import { GitHubClient } from "../lib/client.ts";
import { CHANNEL, CODE_HOST } from "../lib/constants.ts";
import { configApp, configNeeds } from "./config-app.ts";
import { Installation } from "./resource.ts";

/** Installs the config's one App on a repo, as you. Only the router has the App keys that list where each App is installed. */
export class GitHubInstallationProvider implements InstallationProvider {
  readonly id = CHANNEL;

  constructor(private apps: Apps) {}

  installation(repo: string, manifest: RepoManifest, installed: boolean) {
    const slug = configApp(manifest);
    return [new Installation({ slug, repo, installed, needs: configNeeds(manifest, slug) })];
  }

  /** Every repo each App is installed on, skipping suspended installations (they can't mint tokens). */
  async installations(): Promise<CoreInstallation[]> {
    const out: CoreInstallation[] = [];
    for (const slug of this.apps.slugs()) {
      const list = await this.apps.asApp(slug).paginate<{ id: number; suspended_at?: string | null }>("/app/installations");
      for (const installation of list) {
        if (installation.suspended_at) continue;
        const token = await this.apps.token(slug, installation.id, { permissions: { metadata: "read" } });
        const repos = await new GitHubClient(`token ${token.token}`, this.apps.baseUrl).paginate<{ full_name: string }>(
          "/installation/repositories",
          (page) => page.repositories,
        );
        for (const r of repos) out.push({ channel: CHANNEL, source: slug, repo: r.full_name, host: CODE_HOST });
      }
    }
    return out;
  }
}

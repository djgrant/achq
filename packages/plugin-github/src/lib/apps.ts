import { repoName } from "@achq/core";
import { implementationSecret } from "@achq/core/secrets";
import { errors } from "@achq/utils/errors";
import { GitHub, type Installation, type TokenNarrowing } from "@achq/utils/gh";
import { githubUrls } from "./client.ts";
import { GITHUB_API, GITHUB_ENV } from "./constants.ts";
import type { Vars } from "@achq/utils/env";

/** The least a token can ask for: enough to prove the installation reaches a repo. */
const PROBE_PERMISSIONS = { metadata: "read" };

/** From ACHQ_GITHUB_APPS. */
export type AppKeys = Record<string, { id: string; privateKey: string }>;

const isAppKey = (app: any) => Boolean(app) && typeof app.privateKey === "string" && (typeof app.id === "string" || typeof app.id === "number");

/** Reads ACHQ_GITHUB_APPS. */
export const parseApps = (json: string | undefined): AppKeys => {
  if (!json) return {};
  const parsed = Object.entries<any>(JSON.parse(json));
  for (const [slug, app] of parsed) if (!isAppKey(app)) throw new Error(`GitHub App "${slug}" needs an id and a privateKey`);
  return Object.fromEntries(parsed.map(([slug, app]) => [slug, { id: String(app.id), privateKey: app.privateKey }]));
};

/** ACHQ_GITHUB_APPS' JSON, stable, so the same Apps always make the same variable. */
export const appsVariable = (apps: AppKeys) => JSON.stringify(Object.fromEntries(Object.entries(apps).sort(([a], [b]) => a.localeCompare(b))));

/** An App's webhook secret, from its App ID (sent in X-GitHub-Hook-Installation-Target-ID). */
export const appWebhookSecret = (key: string, appId: string | number) => implementationSecret(key, `github-app-webhook:${appId}`);

export type Coverage = { covered: true } | { covered: false; reason: string };

export type FoundInstallation = { slug: string; installation: Installation };

export class Apps {
  private clients = new Map<string, GitHub>();

  constructor(
    private keys: AppKeys = {},
    readonly baseUrl = GITHUB_API,
  ) {}

  slugs() {
    return Object.keys(this.keys);
  }

  has(slug: string) {
    return Object.hasOwn(this.keys, slug);
  }

  byId(id: string) {
    return this.slugs().find((slug) => String(this.keys[slug]!.id) === id);
  }

  /** The API as the App. */
  asApp(slug: string) {
    if (!this.has(slug)) throw new Error(`GitHub App "${slug}" isn't configured on the router`);
    let client = this.clients.get(slug);
    if (!client) {
      const { id, privateKey } = this.keys[slug]!;
      this.clients.set(slug, (client = GitHub.connectAsApp(id, privateKey, { baseUrl: this.baseUrl })));
    }
    return client;
  }

  /** The App's installation on `repo`'s owner, or undefined if it isn't installed there. */
  installation(slug: string, repo: string) {
    return this.asApp(slug).repo(repo).installation();
  }

  /**
   * Whether the installation reaches `repo`. An installation is found by the
   * repo's owner, and may cover only selected repos: minting a token narrowed
   * to `repo` is the one definitive check.
   */
  async covers(slug: string, installationId: number, repo: string): Promise<Coverage> {
    try {
      await this.token(slug, installationId, { repositories: [repoName.split(repo).name], permissions: PROBE_PERMISSIONS });
      return { covered: true };
    } catch (error) {
      return { covered: false, reason: errors.message(error) };
    }
  }

  async installedOn(repo: string): Promise<FoundInstallation | undefined> {
    for (const slug of this.slugs()) {
      const installation = await this.installation(slug, repo);
      if (!installation || installation.suspended_at) continue;
      if ((await this.covers(slug, installation.id, repo)).covered) return { slug, installation };
    }
    return undefined;
  }

  /** An installation token, narrowed to `repositories` (names, not owner/name) and `permissions` when given. */
  token(slug: string, installationId: number, narrow: TokenNarrowing = {}) {
    return this.asApp(slug).createInstallationToken(installationId, narrow);
  }
}

/** The Apps `env` configures. */
export const appsFor = (env: Vars) => new Apps(parseApps(env[GITHUB_ENV.apps]), githubUrls(env).api);

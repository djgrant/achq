import { repoName } from "@achq/core";
import { implementationSecret } from "@achq/core/secrets";
import { collections } from "@achq/utils/collections";
import { errors } from "@achq/utils/errors";
import type { Vars } from "@achq/utils/env";
import { GitHub, type Installation, type TokenNarrowing } from "@achq/utils/gh";
import { GITHUB_API, GITHUB_ENV, githubUrls } from "./constants.ts";
import { AppKeys } from "./schemas.ts";

/** The least a token can ask for: enough to prove the installation reaches a repo. */
const PROBE_PERMISSIONS = { metadata: "read" };

export { AppKeys };

/** Reads ACHQ_GITHUB_APPS. */
export const parseApps = (json: string | undefined): AppKeys => {
  if (!json) return {};
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`${GITHUB_ENV.apps} isn't JSON: it must map each App's slug to its id and privateKey`);
  }
  const parsed = AppKeys.safeParse(value);
  if (parsed.success) return parsed.data;
  const [slug] = parsed.error.issues[0]!.path;
  throw new Error(slug === undefined ? `${GITHUB_ENV.apps} must map each App's slug to its id and privateKey` : `GitHub App "${String(slug)}" needs an id and a privateKey`);
};

/** ACHQ_GITHUB_APPS as the router is given it: what's stored, which it checks, with `added` over it, sorted by slug, so the same Apps always make the same variable. */
export const joinApps = (stored: string | undefined, added: AppKeys) => JSON.stringify(collections.sortKeys({ ...parseApps(stored), ...added }));

/** An App's key in a vault: its item, and its fields. */
export const vaultedApp = {
  item: (slug: string) => `GitHub App ${slug}`,
  fields: ({ id, privateKey }: AppKeys[string]) => ({ app_id: id, private_key: privateKey }),
  /** Undefined unless the item has both. */
  keys: (fields: Record<string, string> | undefined): AppKeys[string] | undefined =>
    fields?.app_id && fields.private_key ? { id: fields.app_id, privateKey: fields.private_key } : undefined,
};

/** The login an App comments and pushes as. */
export const botLogin = (slug: string) => `${slug}[bot]`;

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

  async installedOn(repo: string) {
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

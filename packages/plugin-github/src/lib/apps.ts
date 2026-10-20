// Acting as a GitHub App: its keys, the JWTs they sign, installation tokens,
// and the webhook secret. Only the router and `achq up` have App keys; the
// container never does.
import { implementationSecret } from "@achq/core/secrets";
import { errorMessage } from "@achq/utils/errors";
import { appJwt, type GitHub, type Installation, splitRepo, type TokenNarrowing } from "@achq/utils/gh";
import { github, githubUrls } from "./client.ts";
import { GITHUB_API, GITHUB_ENV } from "./constants.ts";

/** App JWTs are valid for nine minutes and reused for five. */
const JWT_REUSE_MS = 5 * 60_000;

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

/** For one-off calls, where caching buys nothing. */
export const asAppOnce = (api: string, appId: string | number, privateKey: string) => github(`Bearer ${appJwt(appId, privateKey)}`, api);

export type Coverage = { covered: true } | { covered: false; reason: string };

export type FoundInstallation = { slug: string; installation: Installation };

export class Apps {
  private jwts = new Map<string, { value: string; until: number }>();

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

  private key(slug: string) {
    if (!this.has(slug)) throw new Error(`GitHub App "${slug}" isn't configured on the router`);
    return this.keys[slug]!;
  }

  private cachedJwt(slug: string) {
    const { id, privateKey } = this.key(slug);
    const now = Date.now();
    const cached = this.jwts.get(slug);
    if (cached && cached.until > now) return cached.value;
    const value = appJwt(id, privateKey, now);
    this.jwts.set(slug, { value, until: now + JWT_REUSE_MS });
    return value;
  }

  asApp(slug: string): GitHub {
    this.key(slug);
    return github(() => `Bearer ${this.cachedJwt(slug)}`, this.baseUrl);
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
      await this.token(slug, installationId, { repositories: [splitRepo(repo).name], permissions: PROBE_PERMISSIONS });
      return { covered: true };
    } catch (error) {
      return { covered: false, reason: errorMessage(error) };
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

const shared = new Map<string, Apps>();

/** The Apps `env` configures, one per configuration: the router's channel, code host and policy providers share one JWT cache. */
export const appsFor = (env: Record<string, string | undefined>) => {
  const api = githubUrls(env).api;
  const configured = `${api} ${env[GITHUB_ENV.apps] ?? ""}`;
  let apps = shared.get(configured);
  if (!apps) shared.set(configured, (apps = new Apps(parseApps(env[GITHUB_ENV.apps]), api)));
  return apps;
};

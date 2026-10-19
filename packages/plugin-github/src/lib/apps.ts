// Acting as a GitHub App: its keys, the JWTs they sign, installation tokens,
// and the webhook secret. Only the router and `achq up` have App keys; the
// container never does.
import { createSign } from "node:crypto";
import { implementationSecret } from "@achq/core/secrets";
import { GitHubClient, githubUrls } from "./client.ts";
import { GITHUB_API, GITHUB_ENV } from "./constants.ts";
import type { Permissions } from "./permissions.ts";

/** App JWTs are valid for nine minutes and reused for five. */
const JWT_REUSE_MS = 5 * 60_000;

/** `{ [slug]: { id, privateKey } }`, from ACHQ_GITHUB_APPS. */
export type AppKeys = Record<string, { id: string; privateKey: string }>;

/** Reads ACHQ_GITHUB_APPS. */
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

/** ACHQ_GITHUB_APPS' JSON, stable, so the same Apps always make the same variable. */
export const appsVariable = (apps: AppKeys) => JSON.stringify(Object.fromEntries(Object.entries(apps).sort(([a], [b]) => a.localeCompare(b))));

/** A JWT that authenticates as the GitHub App itself, valid for nine minutes. */
export const appJwt = (appId: string | number, privateKey: string, now = Date.now()): string => {
  const iat = Math.floor(now / 1000) - 60;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat, exp: iat + 600, iss: String(appId) })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
};

/** An App's webhook secret, from its App ID (sent in X-GitHub-Hook-Installation-Target-ID). */
export const appWebhookSecret = (key: string, appId: string | number) => implementationSecret(key, `github-app-webhook:${appId}`);

/** `GET /repos/{r}/installation`, the fields achq uses. */
export type InstallationInfo = {
  id: number;
  account: { login: string };
  permissions: Permissions;
  suspended_at?: string | null;
};

export type AccessToken = { token: string; expires_at: string; permissions?: Permissions };

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

  /** The slug of the configured App with this ID. */
  byId(id: string) {
    return this.slugs().find((slug) => String(this.keys[slug]!.id) === id);
  }

  private key(slug: string) {
    if (!this.has(slug)) throw new Error(`GitHub App "${slug}" isn't configured on the router`);
    return this.keys[slug]!;
  }

  /** The API as the App itself. JWTs are reused for five of their nine minutes. */
  asApp(slug: string) {
    const { id, privateKey } = this.key(slug);
    return new GitHubClient(() => {
      const now = Date.now();
      const cached = this.jwts.get(slug);
      if (cached && cached.until > now) return `Bearer ${cached.value}`;
      const value = appJwt(id, privateKey, now);
      this.jwts.set(slug, { value, until: now + JWT_REUSE_MS });
      return `Bearer ${value}`;
    }, this.baseUrl);
  }

  /** The App's installation that covers `repo`, or undefined if it isn't installed there. */
  async installation(slug: string, repo: string): Promise<InstallationInfo | undefined> {
    const res = await this.asApp(slug).raw("GET", `/repos/${repo}/installation`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub GET /repos/${repo}/installation: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as InstallationInfo;
  }

  /** An installation token, narrowed to `repositories` (names, not owner/name) and `permissions` when given. */
  token(slug: string, installation: number, narrow: { repositories?: string[]; permissions?: Permissions } = {}) {
    return this.asApp(slug).request<AccessToken>("POST", `/app/installations/${installation}/access_tokens`, narrow);
  }
}

const shared = new Map<string, Apps>();

/** The Apps `env` configures, one per configuration: the router's channel, installation provider and policy provider share one JWT cache. */
export const appsFor = (env: Record<string, string | undefined>) => {
  const api = githubUrls(env).api;
  const configured = `${api} ${env[GITHUB_ENV.apps] ?? ""}`;
  let apps = shared.get(configured);
  if (!apps) shared.set(configured, (apps = new Apps(parseApps(env[GITHUB_ENV.apps]), api)));
  return apps;
};

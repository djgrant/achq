// Router only: the container never has App keys.
import { appJwt, GITHUB_API, GitHubClient } from "../api.ts";

export type AppKeys = Record<string, { id: string; privateKey: string }>;

export type Permissions = Record<string, string>;

/** `GET /repos/{r}/installation`, the fields achq uses. */
export type InstallationInfo = {
  id: number;
  account: { login: string };
  permissions: Permissions;
  suspended_at?: string | null;
};

export type AccessToken = { token: string; expires_at: string; permissions?: Permissions };

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Whether `granted` covers `wanted` (read < write < admin). */
export const covers = (granted: string | undefined, wanted: string) =>
  granted !== undefined && (RANK[granted] ?? 0) >= (RANK[wanted] ?? Infinity);

export const maxLevel = (a: string | undefined, b: string) => (a !== undefined && (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
      this.jwts.set(slug, { value, until: now + 5 * 60_000 });
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

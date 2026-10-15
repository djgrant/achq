import { createSign } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const API = "https://api.github.com";

/** A JWT that authenticates as the GitHub App itself, valid for nine minutes. */
export const appJwt = (appId: string, privateKey: string, now = Date.now()): string => {
  const iat = Math.floor(now / 1000) - 60;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat, exp: iat + 600, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
};

/**
 * GitHub access as the App's installation on one repo. Installation tokens
 * last an hour, so the current one is also written to `dir` for git's
 * credential helper and gh, which Claude uses, and refreshed before it expires.
 */
export class GitHub {
  bot = { login: "", id: 0 };
  private token?: { value: string; expires: number };

  constructor(
    private appId: string,
    private privateKey: string,
    readonly repo: string,
    private dir: string,
  ) {}

  get tokenFile() {
    return path.join(this.dir, "token");
  }

  get ghConfigDir() {
    return path.join(this.dir, "gh");
  }

  async connect() {
    const jwt = appJwt(this.appId, this.privateKey);
    const app = await this.fetch<{ slug: string }>("GET", "/app", undefined, `Bearer ${jwt}`);
    const login = `${app.slug}[bot]`;
    const user = await this.fetch<{ id: number }>("GET", `/users/${encodeURIComponent(login)}`);
    this.bot = { login, id: user.id };
    await this.installationToken();
  }

  async installationToken(): Promise<string> {
    if (this.token && this.token.expires - Date.now() > 10 * 60_000) return this.token.value;
    const jwt = `Bearer ${appJwt(this.appId, this.privateKey)}`;
    const installation = await this.fetch<{ id: number }>("GET", `/repos/${this.repo}/installation`, undefined, jwt);
    const created = await this.fetch<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
      { repositories: [this.repo.split("/")[1]] },
      jwt,
    );
    this.token = { value: created.token, expires: Date.parse(created.expires_at) };
    fs.mkdirSync(this.ghConfigDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.tokenFile, created.token, { mode: 0o600 });
    fs.writeFileSync(
      path.join(this.ghConfigDir, "hosts.yml"),
      `github.com:\n    oauth_token: ${created.token}\n    user: ${this.bot.login}\n    git_protocol: https\n`,
      { mode: 0o600 },
    );
    return created.token;
  }

  async api<T>(method: string, route: string, body?: unknown): Promise<T> {
    return this.fetch<T>(method, route, body, `token ${await this.installationToken()}`);
  }

  async paginate<T>(route: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const sep = route.includes("?") ? "&" : "?";
      const batch = await this.api<T[]>("GET", `${route}${sep}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  private async fetch<T>(method: string, route: string, body?: unknown, auth?: string): Promise<T> {
    const res = await fetch(API + route, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agentkit-github-agent",
        ...(auth && { authorization: auth }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${route}: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

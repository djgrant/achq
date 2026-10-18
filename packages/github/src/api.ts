import { createSign } from "node:crypto";

export const GITHUB_API = "https://api.github.com";

/** A JWT that authenticates as the GitHub App itself, valid for nine minutes. */
export const appJwt = (appId: string | number, privateKey: string, now = Date.now()): string => {
  const iat = Math.floor(now / 1000) - 60;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat, exp: iat + 600, iss: String(appId) })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
};

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly route: string,
    readonly body: string,
  ) {
    super(`GitHub ${method} ${route}: ${status} ${body.slice(0, 500)}`);
  }
}

/**
 * GitHub's REST API with one authorization: `token …` for an installation or
 * user token, `Bearer …` for an App JWT. `baseUrl` points tests at a fake.
 */
export class GitHubClient {
  constructor(
    private auth: string | (() => string | Promise<string>),
    readonly baseUrl = GITHUB_API,
  ) {}

  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, route, body);
    if (!res.ok) throw new GitHubError(res.status, method, route, await res.text());
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** The response whatever its status, for callers that treat a 404 as an answer. */
  async raw(method: string, route: string, body?: unknown): Promise<Response> {
    const auth = typeof this.auth === "function" ? await this.auth() : this.auth;
    return fetch(this.baseUrl + route, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "achq",
        ...(auth && { authorization: auth }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async paginate<T>(route: string, pick: (page: any) => T[] = (page) => page): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const sep = route.includes("?") ? "&" : "?";
      const batch = pick(await this.request<unknown>("GET", `${route}${sep}per_page=100&page=${page}`));
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }
}

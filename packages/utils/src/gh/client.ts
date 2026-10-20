// GitHub's REST API as raw requests: auth, headers, errors and pages. What the
// routes mean is in github.ts.
import { HttpError } from "../http.ts";

export const GITHUB_API = "https://api.github.com";
export const API_VERSION = "2022-11-28";
export const USER_AGENT = "achq";

/** GitHub's largest page: fewer requests for long lists. */
export const PAGE_SIZE = 100;

export class GitHubError extends HttpError {
  constructor(status: number, method: string, route: string, body: string) {
    super(status, method, route, body, "GitHub");
  }

  get route() {
    return this.path;
  }
}

/** `token …` for an installation or user token, `Bearer …` for an App JWT, or "" for none. A function is asked each request. */
export type Auth = string | (() => string | Promise<string>);

export type ClientOptions = {
  /** Points the client at a fake. */
  baseUrl?: string;
  userAgent?: string;
  apiVersion?: string;
};

export class GitHubClient {
  readonly baseUrl: string;
  private userAgent: string;
  private apiVersion: string;

  constructor(
    private auth: Auth,
    { baseUrl = GITHUB_API, userAgent = USER_AGENT, apiVersion = API_VERSION }: ClientOptions = {},
  ) {
    this.baseUrl = baseUrl;
    this.userAgent = userAgent;
    this.apiVersion = apiVersion;
  }

  /** The response's JSON (undefined for a 204), or a GitHubError if it isn't 2xx. */
  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, route, body);
    if (!res.ok) throw new GitHubError(res.status, method, route, await res.text());
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** As `request`, but a 404 is an answer: undefined. */
  async find<T>(method: string, route: string, body?: unknown): Promise<T | undefined> {
    const res = await this.raw(method, route, body);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new GitHubError(res.status, method, route, await res.text());
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async raw(method: string, route: string, body?: unknown): Promise<Response> {
    const auth = typeof this.auth === "function" ? await this.auth() : this.auth;
    return fetch(this.baseUrl + route, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": this.apiVersion,
        "user-agent": this.userAgent,
        ...(auth && { authorization: auth }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** `pick` finds the items in a page that wraps them. */
  async paginate<T>(route: string, pick: (page: any) => T[] = (page) => page): Promise<T[]> {
    const items: T[] = [];
    const sep = route.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const batch = pick(await this.request<unknown>("GET", `${route}${sep}per_page=${PAGE_SIZE}&page=${page}`));
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return items;
    }
  }
}

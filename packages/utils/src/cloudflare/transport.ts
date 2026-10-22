import { http } from "../http.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Cloudflare turned a request down, or answered with something that isn't its API. `status` is the HTTP status; `codes`, the codes of Cloudflare's errors. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[] = [],
  ) {
    super(message);
  }
}

const NOT_FOUND = 404;

type Envelope<T> = { success: boolean; errors?: { code: number; message: string }[]; result: T };

export type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as it is, e.g. a form or a KV value. */
  body?: string | FormData;
};

export class CloudflareTransport {
  constructor(
    private readonly token: string,
    readonly endpoint = CLOUDFLARE_API,
  ) {}

  private url(path: string, query: RequestOptions["query"] = {}) {
    const url = new URL(this.endpoint + path);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    return url;
  }

  /** The response, whatever its status. */
  async fetch(method: string, path: string, { query, json, body }: RequestOptions = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (json !== undefined) headers["content-type"] = "application/json";
    return fetch(this.url(path, query), { method, headers, body: json === undefined ? body : JSON.stringify(json) });
  }

  /** The envelope's `result`. Anything but success throws, naming the method and path and Cloudflare's errors. */
  async call<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.fetch(method, path, options);
    const text = await res.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new CloudflareError(`Cloudflare ${method} ${path}: ${res.status} ${http.excerpt(text)}`.trimEnd(), res.status);
    }
    if (!res.ok || !envelope.success) {
      const errors = envelope.errors?.map((e) => `${e.message} (${e.code})`).join("; ") ?? "";
      throw new CloudflareError(`Cloudflare ${method} ${path}: ${res.status} ${errors}`.trimEnd(), res.status, envelope.errors?.map((e) => e.code) ?? []);
    }
    return envelope.result;
  }

  /** As `call`, but undefined for a 404: something that isn't there. */
  async find<T>(method: string, path: string, options: RequestOptions = {}): Promise<T | undefined> {
    try {
      return await this.call<T>(method, path, options);
    } catch (e) {
      if (e instanceof CloudflareError && e.status === NOT_FOUND) return undefined;
      throw e;
    }
  }

  /** A body that isn't an envelope, e.g. a KV value: undefined for a 404. */
  async text(path: string) {
    const res = await this.fetch("GET", path);
    if (res.status === NOT_FOUND) return undefined;
    const text = await res.text();
    if (!res.ok) throw new CloudflareError(`Cloudflare GET ${path}: ${res.status} ${http.excerpt(text)}`.trimEnd(), res.status);
    return text;
  }
}

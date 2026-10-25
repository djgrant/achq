import { HttpError } from "../http.ts";
import { allOf, type JsonStore } from "./json-store.ts";

const NOT_FOUND = 404;

/** The names a list answer gives: anything else is the store answering wrongly. */
const names = (value: unknown, url: string) => {
  if (Array.isArray(value) && value.every((name) => typeof name === "string")) return value;
  throw new Error(`Store GET ${new URL(url).pathname}: not a list of names`);
};

/**
 * JSON values by name at `base`, as `storeHandler` serves them: `GET base`
 * lists the names, sorted; `GET`, `PUT` and `DELETE` `base?name=<name>` read,
 * write and remove one. A write is kept once it's answered. Any string is a
 * name: in the query, not the path, so neither a `/` nor a `..` in one can
 * change which path it's at.
 */
export class HttpJsonStore implements JsonStore {
  constructor(
    readonly base: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private url(name: string) {
    return `${this.base}?name=${encodeURIComponent(name)}`;
  }

  private async call(method: string, url: string, body?: string) {
    const res = await this.fetcher(url, { method, body, headers: body === undefined ? undefined : { "content-type": "application/json" } });
    if (method === "GET" && res.status === NOT_FOUND) return undefined;
    if (!res.ok) throw new HttpError(res.status, method, new URL(url).pathname, await res.text(), "Store");
    return res.text();
  }

  async read(name: string): Promise<unknown> {
    const text = await this.call("GET", this.url(name));
    return text === undefined ? undefined : JSON.parse(text);
  }

  async write(name: string, value: unknown) {
    await this.call("PUT", this.url(name), JSON.stringify(value));
  }

  async remove(name: string) {
    await this.call("DELETE", this.url(name));
  }

  async list() {
    const text = await this.call("GET", this.base);
    return text ? names(JSON.parse(text), this.base) : [];
  }

  all() {
    return allOf(this);
  }
}

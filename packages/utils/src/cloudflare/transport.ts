import * as v from "valibot";
import { http } from "../http.ts";
import type { CloudflareOperation } from "./operations.ts";

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

type Envelope = { success: boolean; errors?: { code: number; message: string }[]; result: unknown; result_info?: unknown };

type AnyOperation<P> = CloudflareOperation<P, v.GenericSchema, v.GenericSchema>;

export class CloudflareTransport {
  constructor(
    private readonly token: string,
    readonly endpoint = CLOUDFLARE_API,
  ) {}

  /** The response, whatever its status. */
  private async fetch<P>(operation: AnyOperation<P>, params: P) {
    const url = new URL(this.endpoint + operation.path(params));
    for (const [name, value] of Object.entries(operation.query?.(params) ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    const json = operation.json?.(params);
    if (json !== undefined) headers["content-type"] = "application/json";
    return fetch(url, { method: operation.method, headers, body: json === undefined ? operation.body?.(params) : JSON.stringify(json) });
  }

  /** `value`, as the operation's schema has it. One that doesn't match says where, naming the operation. */
  private parse<S extends v.GenericSchema>(operation: { name: string }, schema: S, value: unknown, where: string, status: number): v.InferOutput<S> {
    const parsed = v.safeParse(schema, value);
    if (parsed.success) return parsed.output;
    const issue = parsed.issues[0];
    const path = [where, v.getDotPath(issue)].filter(Boolean).join(".");
    throw new CloudflareError(`Cloudflare ${operation.name}: ${path}: ${issue.message}`, status);
  }

  /** The envelope. Anything but success throws, naming the method and path and Cloudflare's errors. */
  private async envelope<P>(operation: AnyOperation<P>, params: P) {
    const res = await this.fetch(operation, params);
    const text = await res.text();
    const what = `Cloudflare ${operation.method} ${operation.path(params)}`;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new CloudflareError(`${what}: ${res.status} ${http.excerpt(text)}`.trimEnd(), res.status);
    }
    if (!res.ok || !envelope.success) {
      const errors = envelope.errors?.map((e) => `${e.message} (${e.code})`).join("; ") ?? "";
      throw new CloudflareError(`${what}: ${res.status} ${errors}`.trimEnd(), res.status, envelope.errors?.map((e) => e.code) ?? []);
    }
    return { envelope, status: res.status };
  }

  /** The envelope's `result`, parsed with the operation's schema. */
  async call<P, R extends v.GenericSchema>(operation: CloudflareOperation<P, R>, params: P): Promise<v.InferOutput<R>> {
    const { envelope, status } = await this.envelope(operation, params);
    return this.parse(operation, operation.result, envelope.result, "result", status);
  }

  /** As `call`, but undefined for a 404: something that isn't there. */
  async find<P, R extends v.GenericSchema>(operation: CloudflareOperation<P, R>, params: P): Promise<v.InferOutput<R> | undefined> {
    try {
      return await this.call(operation, params);
    } catch (e) {
      if (e instanceof CloudflareError && e.status === NOT_FOUND) return undefined;
      throw e;
    }
  }

  /** A page of a list: its `result`, and its `result_info`, which says where the next page starts. */
  async page<P, R extends v.GenericSchema, I extends v.GenericSchema>(operation: CloudflareOperation<P, R, I> & { info: I }, params: P) {
    const { envelope, status } = await this.envelope(operation, params);
    return {
      result: this.parse(operation, operation.result, envelope.result, "result", status),
      info: this.parse(operation, operation.info, envelope.result_info, "result_info", status),
    };
  }

  /** A body that isn't an envelope, e.g. a KV value: undefined for a 404. */
  async text<P>(operation: CloudflareOperation<P, v.GenericSchema<string>>, params: P) {
    const res = await this.fetch(operation, params);
    if (res.status === NOT_FOUND) return undefined;
    const text = await res.text();
    if (!res.ok) throw new CloudflareError(`Cloudflare ${operation.method} ${operation.path(params)}: ${res.status} ${http.excerpt(text)}`.trimEnd(), res.status);
    return text;
  }
}

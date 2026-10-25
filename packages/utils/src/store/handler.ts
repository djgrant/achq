// The server side of the store protocol, which `HttpJsonStore` speaks. It
// imports nothing, so the achq Worker bundles it as it is: a container
// Worker's build takes it from achq's archive with the Worker's own source.

/** Where `storeHandler` keeps values, by key: e.g. a Durable Object's storage. A write is kept once it resolves. */
export interface StoreMemory {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

const STORE_PREFIX = "store/";
const SEGMENT = /^[^/]+$/;

const status = (code: number, text: string) => new Response(text, { status: code });

/**
 * Answers the store protocol from `memory`: `GET /<collection>` lists its
 * names, sorted; `GET`, `PUT` and `DELETE` `/<collection>?name=<name>` read,
 * write and remove one value, by any string. A write is kept once it's
 * answered, as `memory` keeps it.
 */
export const storeHandler =
  (memory: StoreMemory) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let segments: string[];
    try {
      segments = url.pathname.slice(1).split("/").map(decodeURIComponent);
    } catch {
      return status(400, "bad path");
    }
    // compat: delete once deployed infras run past cb7a2f1. The path form `/<collection>/<name>`, as services at an older ACHQ_REF name a value.
    const [collection = "", pathName, ...rest] = segments;
    if (!SEGMENT.test(collection) || rest.length || (pathName !== undefined && !SEGMENT.test(pathName))) return status(400, "bad path");
    // A key is the collection's prefix and the name, whatever it is: listing by the prefix finds it.
    const prefix = `${STORE_PREFIX}${collection}/`;
    const name = url.searchParams.get("name") ?? pathName ?? null;
    if (name === null) {
      if (request.method !== "GET") return status(405, "method not allowed");
      const keys = await memory.list(prefix);
      return Response.json(keys.map((k) => k.slice(prefix.length)).sort());
    }
    const key = prefix + name;
    switch (request.method) {
      case "GET": {
        const value = await memory.get(key);
        return value === undefined ? status(404, "not found") : new Response(value, { headers: { "content-type": "application/json" } });
      }
      case "PUT":
        await memory.put(key, await request.text());
        return new Response(null, { status: 204 });
      case "DELETE":
        await memory.delete(key);
        return new Response(null, { status: 204 });
      default:
        return status(405, "method not allowed");
    }
  };

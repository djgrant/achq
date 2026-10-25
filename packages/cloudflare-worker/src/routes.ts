// Where a request goes: from outside, to which port of the Worker's container;
// from its container, to which internal host. Pure, so it runs in tests too.

import { HEADERS, INTERNAL_DOMAIN, INTERNAL_HOSTS, type WorkerSettings } from "./settings.ts";

/** A request from outside: to `port` of the container, or refused. */
export type Inbound = { port: number } | { refuse: number };

/** Public requests go to the public port, if there is one; ones carrying the internal key go to the port they name. */
export const inbound = (headers: Headers, settings: WorkerSettings, isInternalKey: (key: string) => boolean): Inbound => {
  const key = headers.get(HEADERS.key);
  if (key === null) return settings.publicPort ? { port: settings.publicPort } : { refuse: 404 };
  if (!isInternalKey(key)) return { refuse: 401 };
  const port = Number(headers.get(HEADERS.port));
  return Number.isInteger(port) && port > 0 ? { port } : { refuse: 400 };
};

/** A request from the container, by its hostname. */
export type Outbound = { to: "store" | "awake" | "archive" } | { to: "worker"; worker: string; port: number } | { to: "unknown" };

/** `<port>.<worker>.achq.internal` is another Worker's container; the INTERNAL_HOSTS are this one's. */
export const outbound = (hostname: string): Outbound => {
  if (hostname === INTERNAL_HOSTS.store) return { to: "store" };
  if (hostname === INTERNAL_HOSTS.awake) return { to: "awake" };
  if (hostname === INTERNAL_HOSTS.archive) return { to: "archive" };
  const match = hostname.match(new RegExp(`^(\\d+)\\.([a-z0-9-]+)\\.${INTERNAL_DOMAIN.replace(".", "\\.")}$`));
  return match ? { to: "worker", worker: match[2]!, port: Number(match[1]) } : { to: "unknown" };
};

/** Another Worker's public URL for a path. */
export const workerUrl = (worker: string, settings: WorkerSettings, pathAndQuery: string) => `https://${worker}.${settings.workersDev}${pathAndQuery}`;

/** The JSON store, as the router and deployer reach it at `store.achq.internal` (`HttpJsonStore`): `/<collection>` lists, `/<collection>?name=<name>` is one value, by any string. */
export interface StoreMemory {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

const STORE_PREFIX = "store/";
const SEGMENT = /^[^/]+$/;

/** Answers a store request, for `pathAndQuery`, from `memory`. A write is kept once it's answered, as Durable Object storage keeps it. */
export const storeRequest = async (method: string, pathAndQuery: string, body: string, memory: StoreMemory): Promise<Response> => {
  const url = new URL(pathAndQuery, "http://store");
  let segments: string[];
  try {
    segments = url.pathname.slice(1).split("/").map(decodeURIComponent);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  // compat: delete once deployed infras run past cb7a2f1. The path form `/<collection>/<name>`, as services at an older ACHQ_REF name a value.
  const [collection = "", pathName, ...rest] = segments;
  if (!SEGMENT.test(collection) || rest.length || (pathName !== undefined && !SEGMENT.test(pathName))) return new Response("bad path", { status: 400 });
  // A key is the collection's prefix and the name, whatever it is: listing by the prefix finds it.
  const prefix = `${STORE_PREFIX}${collection}/`;
  const name = url.searchParams.get("name") ?? pathName ?? null;
  if (name === null) {
    if (method !== "GET") return new Response("method not allowed", { status: 405 });
    const keys = await memory.list(prefix);
    return Response.json(keys.map((k) => k.slice(prefix.length)).sort());
  }
  const key = prefix + name;
  switch (method) {
    case "GET": {
      const value = await memory.get(key);
      return value === undefined ? new Response("not found", { status: 404 }) : new Response(value, { headers: { "content-type": "application/json" } });
    }
    case "PUT":
      await memory.put(key, body);
      return new Response(null, { status: 204 });
    case "DELETE":
      await memory.delete(key);
      return new Response(null, { status: 204 });
    default:
      return new Response("method not allowed", { status: 405 });
  }
};

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

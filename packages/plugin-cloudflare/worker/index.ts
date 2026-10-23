// The Worker every achq service and container runs as on Cloudflare: one
// Durable Object, `Service`, whose container is the router, the deployer or a
// repo's container. Its public URL takes the public port's requests, if it has
// one, and requests from achq's other Workers, which carry the account's
// internal key and the port they're for. Its container's requests to
// `*.achq.internal` go through `Outbound`: to its own store, keep-awake and
// archive, or to another Worker's container.

import { DurableObject, type DurableObjectState, type R2Bucket, WorkerEntrypoint, type WorkerVersionMetadata } from "cloudflare:workers";
import { type Box, Lifecycle, type Memory } from "./lifecycle.ts";
import { inbound, outbound, storeRequest, workerUrl } from "./routes.ts";
import { DATA_DIR, DEPLOYER_TOKEN, HEADERS, INTERNAL_DOMAIN, SERVICE_INSTANCE, type WorkerSettings } from "./settings.ts";

type Env = {
  /** What it is: written into its config by achq. */
  ACHQ_SERVICE: WorkerSettings;
  /** Its container's variables, as JSON: a secret. */
  ACHQ_ENV: string;
  /** What achq's Workers prove themselves to each other with: a secret. */
  ACHQ_INTERNAL_KEY: string;
  /** The deployer's own Cloudflare token: a secret only the deployer's Worker has. */
  [DEPLOYER_TOKEN]?: string;
  ARCHIVE: R2Bucket;
  /** Which version of the Worker this is: VERSION_BINDING. */
  VERSION: WorkerVersionMetadata;
};

const decoder = new TextDecoder();

/** Compares without leaking where they differ. */
const sameKey = (a: string, b: string) => {
  if (!b || a.length !== b.length) return false;
  let differ = 0;
  for (let i = 0; i < a.length; i++) differ |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differ === 0;
};

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** The one Service of this Worker. */
const service = (exports: DurableObjectState["exports"]) => exports.Service.get(exports.Service.idFromName(SERVICE_INSTANCE));

/** Without the internal headers, which only this Worker sets: with `to`, those for its Durable Object. */
const stripped = (req: Request, to?: { port: number; version: string }) => {
  const headers = new Headers(req.headers);
  headers.delete(HEADERS.key);
  headers.delete(HEADERS.port);
  headers.delete(HEADERS.version);
  if (to) {
    headers.set(HEADERS.port, String(to.port));
    headers.set(HEADERS.version, to.version);
  }
  return new Request(req, { headers });
};

/** Over HTTP, as a container takes no HTTPS: the connection to it is already secure. */
const toContainer = (req: Request) => {
  const url = new URL(req.url);
  url.protocol = "http:";
  return new Request(url.href, stripped(req));
};

export default {
  async fetch(req: Request, env: Env, ctx: { exports: DurableObjectState["exports"] }) {
    const route = inbound(req.headers, env.ACHQ_SERVICE, (key) => sameKey(key, env.ACHQ_INTERNAL_KEY));
    if ("refuse" in route) return new Response(route.refuse === 404 ? "not found" : "refused", { status: route.refuse });
    const forwarded = stripped(req, { port: route.port, version: env.VERSION.timestamp });
    if (forwarded.body) return service(ctx.exports).fetch(forwarded);
    // One without a body can be sent again, as it is when the object it reached was on an older version and stepped aside.
    try {
      return await service(ctx.exports).fetch(forwarded.clone());
    } catch {
      return service(ctx.exports).fetch(forwarded);
    }
  },
};

export class Service extends DurableObject<Env> {
  private readonly lifecycle: Lifecycle;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) throw new Error("This Worker has no container");
    const settings = env.ACHQ_SERVICE;
    const variables = JSON.parse(env.ACHQ_ENV || "{}") as Record<string, string>;
    const token = env[DEPLOYER_TOKEN];
    const secrets: Record<string, string> = token ? { [DEPLOYER_TOKEN]: token } : {};
    const box: Box = {
      get running() {
        return container.running;
      },
      get images() {
        return container.images;
      },
      start: ({ env: startEnv, ...options }) => {
        container.start({ ...options, ...(startEnv && { env: startEnv }), enableInternet: true });
        // Cloudflare keeps no container output, so how it stopped is logged, for `wrangler tail`.
        ctx.waitUntil(
          container.monitor().then(
            () => console.log(`${settings.name}: its container stopped`),
            (e: { exitCode?: number; message?: string }) => console.error(`${settings.name}: its container stopped with exit code ${e?.exitCode ?? "unknown"}: ${e?.message ?? e}`),
          ),
        );
      },
      intercept: () => container.interceptOutboundHttp(`*.${INTERNAL_DOMAIN}`, ctx.exports.Outbound({ props: {} })),
      setInactivityTimeout: (ms) => container.setInactivityTimeout(ms),
      snapshot: (name) => container.snapshotContainer({ name }),
      destroy: () => container.destroy(),
      exec: async (command, execEnv) => {
        const output = await (await container.exec(command, { env: execEnv })).output();
        return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
      },
      answers: async (port) => {
        try {
          await (await container.getTcpPort(port).fetch("http://container/")).body?.cancel();
          return true;
        } catch {
          return false;
        }
      },
    };
    const memory: Memory = {
      get: (key) => ctx.storage.get(key),
      put: (key, value) => ctx.storage.put(key, value),
      delete: async (key) => void (await ctx.storage.delete(key)),
    };
    let config = "";
    this.lifecycle = new Lifecycle({
      settings,
      env: { ...variables, DATA_DIR },
      secrets,
      get config() {
        return config;
      },
      box,
      memory,
    });
    // A new version of the Worker starts a new object, once the old one steps aside: a service whose config changed restarts with it.
    console.log(`${settings.name}: started on version ${env.VERSION.id} of its Worker, made ${env.VERSION.timestamp}`);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      // A new token restarts the deployer with it.
      config = await sha256(JSON.stringify({ settings, variables, secrets, images: container.images }));
      if (container.running) await container.setInactivityTimeout(30 * 60_000).catch(() => {});
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
    });
  }

  async fetch(req: Request) {
    // Cloudflare moves an object onto its Worker's new version in its own time, which can be minutes, and until then it runs with the old variables.
    // So one that a newer version reaches resets, and the next call starts one on it, which restarts the service if its config changed.
    // Only for a request without a body, which its Worker sends again.
    if (!req.body && Date.parse(req.headers.get(HEADERS.version) ?? "") > Date.parse(this.env.VERSION.timestamp)) {
      console.log(`${this.env.ACHQ_SERVICE.name}: a newer version of its Worker is deployed; stepping aside`);
      this.ctx.abort("a newer version of its Worker is deployed");
    }
    await this.ready;
    const port = Number(req.headers.get(HEADERS.port));
    const response = await this.lifecycle.serve(port, () => this.ctx.container!.getTcpPort(port).fetch(toContainer(req)));
    await this.lookAgain();
    return response;
  }

  async alarm() {
    await this.ready;
    const next = await this.lifecycle.tick();
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  /** Makes sure the alarm will look at the container while it runs. */
  private async lookAgain() {
    if (this.ctx.container?.running && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  // ── For Outbound ──

  async awake() {
    await this.lifecycle.touch();
  }

  async store(method: string, path: string, body: string) {
    const storage = this.ctx.storage;
    const response = await storeRequest(method, path, body, {
      get: (key) => storage.get<string>(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      list: async (prefix) => [...(await storage.list<string>({ prefix })).keys()],
    });
    return { status: response.status, body: await response.text() };
  }
}

/** Where the container's requests to `*.achq.internal` go. */
export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(req: Request) {
    const url = new URL(req.url);
    const settings = this.env.ACHQ_SERVICE;
    const route = outbound(url.hostname);
    switch (route.to) {
      case "store": {
        const { status, body } = await service(this.ctx.exports).store(req.method, url.pathname, await req.text());
        return new Response(status === 204 ? null : body, { status, headers: { "content-type": "application/json" } });
      }
      case "awake":
        await service(this.ctx.exports).awake();
        return new Response("awake");
      case "archive":
        return this.archive(req, `${settings.name}/data.tar.gz`);
      case "worker": {
        const headers = new Headers(req.headers);
        headers.set(HEADERS.key, this.env.ACHQ_INTERNAL_KEY);
        headers.set(HEADERS.port, String(route.port));
        return fetch(workerUrl(route.worker, settings, url.pathname + url.search), { method: req.method, headers, body: req.body, redirect: "manual" });
      }
      case "unknown":
        return new Response(`No achq Worker answers ${url.hostname}`, { status: 502 });
    }
  }

  /** The container's own archive: only ever its own key. */
  private async archive(req: Request, key: string) {
    if (req.method === "PUT") {
      const length = Number(req.headers.get("content-length") ?? "0");
      if (!req.body || !length) return new Response("content-length required", { status: 411 });
      // R2 takes a streamed upload as a stream of known length.
      const fixed = new FixedLengthStream(length);
      await Promise.all([req.body.pipeTo(fixed.writable), this.env.ARCHIVE.put(key, fixed.readable)]);
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET") {
      const object = await this.env.ARCHIVE.get(key);
      return object ? new Response(object.body, { headers: { "content-length": String(object.size) } }) : new Response("not found", { status: 404 });
    }
    return new Response("method not allowed", { status: 405 });
  }
}

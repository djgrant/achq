/**
 * The router holds every App's key, so it stays small. It only parses JSON and
 * checks signatures. Everything else lives behind the interfaces it's handed.
 */
import { type CredentialsRequest, type ClaimRequest, type EventEnvelope, type Installation, type MintRequest, type SourceSettings, type ValidateRequest, type WakeRequest, type PolicyData, type AccessProvider, type Channel, type ChannelEvent, type Credential, type RouterRepoConfig, threadKey } from "@achq/core";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { signedHeaders, verifySigned } from "@achq/core/signing";
import { createStore, repoFile, safeName } from "./store.ts";
import { type Claims, type Target, targetsFor } from "./targets.ts";

/** Milliseconds between attempts while a sleeping service wakes: about five minutes in all. */
export const DELAYS = [2, 4, 8, 15, 30, 30, 30, 30, 60, 60].map((s) => s * 1000);

export type RouterDeps = {
  channels: Channel[];
  providers: AccessProvider[];
  /** AGENT_WEBHOOK_KEY. */
  key: string;
  /** The router's volume. */
  dataDir: string;
  deployerUrl: string;
  installations: () => Promise<Installation[]>;
  sources: () => Promise<SourceSettings[]>;
  fetch?: typeof fetch;
  delays?: number[];
  /** How long one attempt to deliver an event or wake a service may take. */
  attemptTimeout?: number;
  now?: () => number;
  /** For `/wake`'s permission check. */
  githubApi?: string;
  log?: (line: string) => void;
};

/** What's on the volume for each accepted delivery until every target has answered. */
export type InboxEntry = { event: ChannelEvent; commit?: string; targets: Target[] };
export type FailedEntry = InboxEntry & { targets: (Target & { error: string })[] };

const REPO = /^[\w.-]+\/[\w.-]+$/;

const text = (body: string, status = 200) => new Response(body, { status });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const parse = <T>(body: string): Partial<T> | undefined => {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const createRouter = (deps: RouterDeps) => {
  const { key, channels, providers, deployerUrl } = deps;
  const fetchFn = deps.fetch ?? fetch;
  const delays = deps.delays ?? DELAYS;
  const attemptTimeout = deps.attemptTimeout ?? 30_000;
  const now = deps.now ?? Date.now;
  const githubApi = deps.githubApi ?? "https://api.github.com";
  const log = deps.log ?? console.log;
  const store = createStore(deps.dataDir);

  // Router config and claims, by lowercased repo. Loaded on start, written through to the volume.
  const repos = new Map<string, RouterRepoConfig>();
  const claims = new Map<string, Claims>();
  const configOf = (repo: string | undefined) => (repo ? repos.get(repo.toLowerCase()) : undefined);

  // Deliveries being forwarded, so a duplicate isn't queued twice, and so tests can wait for them.
  const inFlight = new Map<string, Promise<void>>();

  // ── Reaching services ──────────────────────────────────────────────────────

  /** A request signed for `url`'s path. Signed per attempt, since retries outlast the timestamp's window. */
  const signed = (secret: string, method: string, url: string, body?: string, signal?: AbortSignal): RequestInit => {
    const { pathname, search } = new URL(url);
    return {
      method,
      body,
      signal,
      headers: { ...(body !== undefined && { "content-type": "application/json" }), ...signedHeaders(secret, method, pathname + search, body ?? "", now()) },
    };
  };

  /** Attempts until a service answers with anything but a 5xx. */
  const reach = async (attempt: (signal?: AbortSignal) => Promise<Response>, timeout?: number) => {
    let last = "";
    for (const delay of [0, ...delays]) {
      if (delay) await Bun.sleep(delay);
      try {
        const res = await attempt(timeout ? AbortSignal.timeout(timeout) : undefined);
        if (res.status < 500) return { ok: true as const, res };
        last = `${res.status} ${await res.text()}`.trim();
      } catch (e) {
        last = message(e);
      }
    }
    return { ok: false as const, error: `gave up after ${delays.length + 1} attempts (${last})` };
  };

  const send = (target: Target, entry: InboxEntry) => async (signal?: AbortSignal) => {
    if (target.kind === "deployer") {
      const envelope: EventEnvelope = { event: entry.event };
      return fetchFn(`${deployerUrl}/events`, signed(adminSecret(key), "POST", `${deployerUrl}/events`, JSON.stringify(envelope), signal));
    }
    const envelope: EventEnvelope = { event: entry.event, commit: entry.commit };
    const secret = containerSecret(key, target.repo, target.container);
    return fetchFn(`${target.url}/events`, signed(secret, "POST", `${target.url}/events`, JSON.stringify(envelope), signal));
  };

  const describe = (t: Target) => (t.kind === "deployer" ? "deployer" : `${t.repo}/${t.container}`);

  /** Forwards to every target, then clears the inbox. Targets that never answer go to `failed/`. */
  const deliver = async (entry: InboxEntry) => {
    const { delivery } = entry.event;
    const results = await Promise.all(
      entry.targets.map(async (target) => {
        const result = await reach(send(target, entry), attemptTimeout);
        if (result.ok) await result.res.body?.cancel();
        log(`${delivery} ${entry.event.type} → ${describe(target)}: ${result.ok ? result.res.status : result.error}`);
        return { target, error: result.ok ? undefined : result.error };
      }),
    );
    const failed = results.flatMap(({ target, error }) => (error ? [{ ...target, error }] : []));
    if (failed.length) await store.write("failed", delivery, { ...entry, targets: failed } satisfies FailedEntry);
    await store.remove("inbox", delivery);
  };

  const track = (entry: InboxEntry) => {
    const { delivery } = entry.event;
    const done = deliver(entry)
      .catch((e) => log(`${delivery}: ${message(e)}`))
      .finally(() => inFlight.delete(delivery));
    inFlight.set(delivery, done);
  };

  // ── Webhooks ───────────────────────────────────────────────────────────────

  const verified = async (headers: Headers, body: string) => {
    for (const channel of channels) {
      const source = await channel.verify(headers, body);
      if (source) return { channel, source };
    }
  };

  const webhook = async (req: Request) => {
    const body = await req.text();
    const found = await verified(req.headers, body);
    if (!found) return text("bad signature", 401);
    const event = found.channel.parse(found.source, req.headers, body);
    if (!event) return text("ignored");
    if (!safeName(event.delivery)) return text("bad delivery id", 400);

    const config = configOf(event.repo);
    const targets = targetsFor(found.channel, event, config, claims.get(event.repo?.toLowerCase() ?? "") ?? {});
    if (!targets.length) return text("no match");
    if (inFlight.has(event.delivery)) return text("duplicate", 202);

    // Persisted before answering, so a crash or restart doesn't lose it.
    const entry: InboxEntry = { event, commit: config?.commit, targets };
    inFlight.set(event.delivery, Promise.resolve());
    try {
      await store.write("inbox", event.delivery, entry);
    } catch (e) {
      inFlight.delete(event.delivery);
      throw e;
    }
    // Answer now: the channel gives up after seconds, and a waking service takes longer.
    track(entry);
    return text("accepted", 202);
  };

  // ── Wake, for `achq ssh` ───────────────────────────────────────────────────

  const canPush = async (repo: string, token: string) => {
    const res = await fetchFn(`${githubApi}/repos/${repo}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "achq-router" },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { permissions?: { push?: boolean } };
    return data.permissions?.push === true;
  };

  const wake = async (req: Request) => {
    const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) return text("missing token", 401);
    const request = parse<WakeRequest>(await req.text());
    if (typeof request?.repo !== "string" || !REPO.test(request.repo) || typeof request.container !== "string") return text("bad request", 400);
    // Checked before saying whether the repo is deployed, so strangers learn nothing.
    if (!(await canPush(request.repo, token))) return text("no push access", 403);
    const container = configOf(request.repo)?.containers.find((c) => c.name === request.container);
    if (!container) return text("not deployed", 404);
    const result = await reach((signal) => fetchFn(`${container.url}/`, { signal }), attemptTimeout);
    if (!result.ok) return text(result.error, 504);
    await result.res.body?.cancel();
    return text("awake");
  };

  // ── Credentials and claims, from containers ───────────────────────────────

  const provider = (id: string) => {
    const found = providers.find((p) => p.id === id);
    if (!found) throw new Error(`No access provider "${id}"`);
    return found;
  };

  /** One `mint` per provider, for the policies that name it. */
  const mint = async (policies: PolicyData[], repo: string) => {
    const ids = [...new Set(policies.map((p) => p.provider))];
    const minted = await Promise.all(ids.map((id) => provider(id).mint(policies.filter((p) => p.provider === id), repo)));
    return minted.flat();
  };

  /** One client credential per (channel, source) the container's workspaces select threads from. */
  const mintClients = async (config: RouterRepoConfig, container: string): Promise<Credential[]> => {
    const sources = new Map<string, { channel: string; source: string }>();
    for (const w of config.workspaces) {
      const { channel, source } = w.threads;
      if (w.container === container && typeof source === "string") sources.set(`${channel}\n${source}`, { channel, source });
    }
    return Promise.all(
      [...sources.values()].map(({ channel, source }) => {
        const found = channels.find((c) => c.id === channel);
        if (!found) throw new Error(`No channel "${channel}"`);
        return found.mintClient(source, config.repo);
      }),
    );
  };

  /** A container-signed request: the body names the container, and the signature proves it's that container. */
  const fromContainer = async <T extends { repo: string; container: string }>(req: Request, path: string) => {
    const body = await req.text();
    const request = parse<T>(body);
    if (typeof request?.repo !== "string" || typeof request.container !== "string") return { error: text("bad request", 400) };
    if (!verifySigned(containerSecret(key, request.repo, request.container), "POST", path, body, req.headers, now())) return { error: text("bad signature", 401) };
    const config = configOf(request.repo);
    const container = config?.containers.find((c) => c.name === request.container);
    if (!config || !container) return { error: text("no such container", 404) };
    return { request: request as T, config, container };
  };

  const credentials = async (req: Request) => {
    const found = await fromContainer<CredentialsRequest>(req, "/credentials");
    if ("error" in found) return found.error;
    const { config, container } = found;
    return json({ credentials: await mint(container.policies, config.repo), channels: await mintClients(config, container.name) });
  };

  const claim = async (req: Request) => {
    const found = await fromContainer<ClaimRequest>(req, "/claims");
    if ("error" in found) return found.error;
    const { request, config } = found;
    if (!request.thread || typeof request.thread.channel !== "string" || typeof request.thread.id !== "string") return text("bad request", 400);
    if (!config.workspaces.some((w) => w.name === request.workspace && w.container === request.container)) return text("no such workspace", 404);
    const repo = config.repo.toLowerCase();
    const repoClaims = claims.get(repo) ?? {};
    const thread = threadKey(request.thread);
    repoClaims[thread] = { ...repoClaims[thread], [request.container]: request.workspace };
    claims.set(repo, repoClaims);
    await store.write("claims", repoFile(repo), repoClaims);
    return new Response(null, { status: 204 });
  };

  // ── Admin: the deployer and the infra CLI ─────────────────────────────────

  /** Forwards to the deployer, waking it, and passes its answer back. */
  const toDeployer = async (method: string, path: string, body?: string) => {
    const url = `${deployerUrl}${path}`;
    const result = await reach((signal) => fetchFn(url, signed(adminSecret(key), method, url, body, signal)));
    if (!result.ok) return text(result.error, 504);
    return new Response(await result.res.text(), { status: result.res.status, headers: { "content-type": result.res.headers.get("content-type") ?? "application/json" } });
  };

  const putRepo = async (path: string, body: string) => {
    const config = parse<RouterRepoConfig>(body);
    const valid =
      config?.repo?.toLowerCase() === path.toLowerCase() &&
      typeof config.commit === "string" &&
      [config.containers, config.workspaces, config.triggers].every(Array.isArray);
    if (!valid) return text("bad config", 400);
    // Written before it's live, so what's served is always what a restart would load.
    await store.write("repos", repoFile(path), config);
    repos.set(path.toLowerCase(), config as RouterRepoConfig);
    return new Response(null, { status: 204 });
  };

  const admin = async (req: Request) => {
    const url = new URL(req.url);
    const body = await req.text();
    if (!verifySigned(adminSecret(key), req.method, url.pathname + url.search, body, req.headers, now())) return text("bad signature", 401);
    const repoPath = url.pathname.match(/^\/admin\/repos\/([\w.-]+\/[\w.-]+)$/)?.[1];

    if (repoPath && req.method === "PUT") return putRepo(repoPath, body);
    if (repoPath && req.method === "DELETE") {
      // Claims are kept: reinstalling brings everything back as it was.
      await store.remove("repos", repoFile(repoPath));
      repos.delete(repoPath.toLowerCase());
      return new Response(null, { status: 204 });
    }
    switch (`${req.method} ${url.pathname}`) {
      case "GET /admin/repos":
        return json([...repos.values()]);
      case "POST /admin/mint": {
        const request = parse<MintRequest>(body);
        if (typeof request?.repo !== "string" || !Array.isArray(request.policies)) return text("bad request", 400);
        return json(await mint(request.policies, request.repo));
      }
      case "POST /admin/validate": {
        const request = parse<ValidateRequest>(body);
        if (typeof request?.repo !== "string" || !Array.isArray(request.policies)) return text("bad request", 400);
        const repo = request.repo;
        const problems = await Promise.all(
          request.policies.map((p) => {
            const found = providers.find((x) => x.id === p.provider);
            return found ? found.validate(p, repo) : [`No access provider "${p.provider}"`];
          }),
        );
        return json({ problems: problems.flat() });
      }
      case "GET /admin/installations":
        return json(await deps.installations());
      case "GET /admin/sources":
        return json(await deps.sources());
      case "POST /admin/sync":
        return toDeployer("POST", "/sync", body);
      case "GET /admin/status":
        return toDeployer("GET", "/status");
    }
    return text("not found", 404);
  };

  // ── Ports ──────────────────────────────────────────────────────────────────

  const guarded = (handle: (req: Request, pathname: string) => Promise<Response | undefined> | undefined) => async (req: Request) => {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/") return text("ok");
    try {
      return (await handle(req, pathname)) ?? text("not found", 404);
    } catch (e) {
      log(`${req.method} ${pathname}: ${message(e)}`);
      return text("internal error", 500);
    }
  };

  /** Webhooks, `/wake`, and admin for the infra CLI. Never credentials or claims. */
  const publicFetch = guarded((req, pathname) => {
    if (req.method === "POST" && pathname === "/webhook") return webhook(req);
    if (req.method === "POST" && pathname === "/wake") return wake(req);
    if (pathname.startsWith("/admin/")) return admin(req);
  });

  /** Reached only over the private network: containers and the deployer. */
  const privateFetch = guarded((req, pathname) => {
    if (req.method === "POST" && pathname === "/credentials") return credentials(req);
    if (req.method === "POST" && pathname === "/claims") return claim(req);
    if (pathname.startsWith("/admin/")) return admin(req);
  });

  /** Forwards everything left in the inbox, with the targets it was stored with. */
  const replay = async () => {
    for (const delivery of await store.list("inbox")) {
      if (inFlight.has(delivery)) continue;
      const entry = await store.read<InboxEntry>("inbox", delivery);
      if (entry) track(entry);
    }
  };

  /** Loads config and claims from the volume, then replays the inbox in the background. Call before serving. */
  const start = async () => {
    for (const name of await store.list("repos")) {
      const config = await store.read<RouterRepoConfig>("repos", name);
      if (config) repos.set(config.repo.toLowerCase(), config);
    }
    for (const name of await store.list("claims")) {
      const repoClaims = await store.read<Claims>("claims", name);
      if (repoClaims) claims.set(name.replace("__", "/"), repoClaims);
    }
    await replay();
  };

  /** Resolves once every delivery being forwarded has finished. */
  const settled = async () => {
    while (inFlight.size) await Promise.all(inFlight.values());
  };

  return { publicFetch, privateFetch, start, replay, settled };
};

export type Router = ReturnType<typeof createRouter>;

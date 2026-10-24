import { type ChannelProvider, type CodeHostProvider, type CredentialsResponse, type DeployerEvent, repoName } from "@achq/core";
import { CredentialsRequest, InstallationRequest, MintRequest, RepoRequest, RouterRepoConfig, ValidateRequest, WakeRequest } from "@achq/core/protocol";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { isSigned, signedBy } from "@achq/core/signing";
import { collections } from "@achq/utils/collections";
import { disk } from "@achq/utils/disk";
import { http } from "@achq/utils/http";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { REPO_PATH } from "./constants.ts";
import { claimsOf, configOf, createContext, type RouterDeps } from "./context.ts";
import { mint, mintClients, validate } from "./credentials.ts";
import { acceptDelivery, type InboxEntry, type Reservation, listFailed, replay, replayFailed, reserveClaims, settled, targetsFor } from "./deliveries.ts";
import { fetchSigned, reach } from "./reach.ts";

type Container = RouterRepoConfig["containers"][number];

export const createRouter = (deps: RouterDeps) => {
  const ctx = createContext(deps);

  /** Forwards a request to the deployer, waking it, and relays its answer: JSON unless it says otherwise. */
  const toDeployer = async (method: string, path: string, body?: string) => {
    const url = `${ctx.deployerUrl}${path}`;
    const result = await reach(ctx.delays, (signal) => fetchSigned(ctx, adminSecret(ctx.key), method, url, body, signal));
    if (!result.ok) return new Response(result.error, { status: 504 });
    const { res } = result;
    return new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  };

  // For the deployer and the infra CLI, on both ports, signed with the admin secret.
  const admin = new Hono()
    .use(signedBy(adminSecret(ctx.key), ctx.now))
    .get("/repos", (c) => c.json([...ctx.repos.values()]))
    .put(REPO_PATH, zValidator("json", RouterRepoConfig), async (c) => {
      const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
      const config = c.req.valid("json");
      if (!repoName.same(config.repo, repo)) return c.text("bad config", 400);
      // Written before it's live, so what's served is always what a restart would load.
      await ctx.store.repos.write(repoName.file(repo), config);
      ctx.repos.set(repoName.key(repo), config);
      return c.body(null, 204);
    })
    .delete(REPO_PATH, async (c) => {
      const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
      // Claims are kept: reinstalling brings everything back as it was.
      await ctx.store.repos.remove(repoName.file(repo));
      ctx.repos.delete(repoName.key(repo));
      return c.body(null, 204);
    })
    .post("/mint", zValidator("json", MintRequest), async (c) => {
      const { policies, repo } = c.req.valid("json");
      return c.json(await mint(ctx, policies, repo));
    })
    .post("/validate", zValidator("json", ValidateRequest), async (c) => {
      const { policies, repo } = c.req.valid("json");
      return c.json({ problems: await validate(ctx, policies, repo) });
    })
    .get("/installed", async (c) => c.json((await Promise.all(Object.values(ctx.codeHostProviders).map((h) => h.installed()))).flat()))
    .get("/sources", async (c) => c.json((await Promise.all(ctx.channelProviders.map((channel) => channel.sources()))).flat()))
    .post("/sync", async (c) => toDeployer("POST", "/sync", await c.req.text()))
    .get("/sync/:id", (c) => toDeployer("GET", `/sync/${encodeURIComponent(c.req.param("id"))}`))
    .get("/status", () => toDeployer("GET", "/status"))
    .get("/deployer", () => toDeployer("GET", "/version"))
    .get("/failed", async (c) => c.json(await listFailed(ctx)))
    .post("/failed/replay", async (c) => c.json(await replayFailed(ctx)));

  /**
   * The repo's code host, if the request's bearer token can push to the repo;
   * otherwise the response refusing it. Checked before saying anything about
   * the repo, so strangers learn nothing.
   */
  const pusher = async (req: Request, request: RepoRequest): Promise<CodeHostProvider | Response> => {
    const token = http.bearerToken(req);
    if (!token) return new Response("missing token", { status: 401 });
    if (!repoName.pattern.test(request.repo)) return new Response("bad request", { status: 400 });
    const host = collections.own(ctx.codeHostProviders, request.host);
    if (!host) return new Response("unknown host", { status: 400 });
    if (!(await host.canPush(request.repo, token))) return new Response("no push access", { status: 403 });
    return host;
  };

  /** The channel whose signature a delivery carries, and the source it's from. */
  const verifiedChannel = async (headers: Headers, body: string): Promise<{ channel: ChannelProvider; source: string } | undefined> => {
    for (const channel of ctx.channelProviders) {
      const source = await channel.verify(headers, body);
      if (source) return { channel, source };
    }
  };

  const publicApp = http
    .service(ctx.log)
    .route("/admin", admin)
    .post("/webhook", async (c) => {
      const body = await c.req.text();
      const headers = c.req.raw.headers;
      const found = await verifiedChannel(headers, body);
      if (!found) return c.text("bad signature", 401);
      const parsed = found.channel.parse(found.source, headers, body);
      if (!parsed) return c.text("ignored");
      // The delivery ID names its inbox file.
      if (!disk.isSafeFileName(parsed.event.delivery)) return c.text("bad delivery id", 400);

      let entry: InboxEntry;
      let claim: Reservation | undefined;
      if (parsed.to === "deployer") {
        // A repo isn't deployed until its install is handled, so installs always go through; a push only for a repo that's deployed.
        const deployed = (repos: string[]) => repos.filter((repo) => configOf(ctx, repo));
        // onlyIfDeployed is the router's to act on, so it isn't forwarded.
        const { onlyIfDeployed, ...decided } = parsed.event;
        const forDeployer: DeployerEvent = onlyIfDeployed ? { ...decided, deploy: deployed(decided.deploy), uninstall: deployed(decided.uninstall) } : decided;
        if (!forDeployer.deploy.length && !forDeployer.uninstall.length) return c.text("no match");
        entry = { to: "deployer", event: forDeployer };
      } else {
        const { event } = parsed;
        const targets = targetsFor(found.channel, event, configOf(ctx, event.repo), claimsOf(ctx, event.repo));
        if (!targets.length) return c.text("no match");
        entry = { to: "containers", event, targets };
        // Claimed now, before anything is awaited, so a concurrent event on the thread goes to the same workspace.
        claim = reserveClaims(ctx, event, targets);
      }
      // Persisted before answering, so a crash or restart doesn't lose it. Answered
      // without waiting for the targets: the channel gives up after seconds, and a
      // waking service takes longer. The claim is written to the store once the event
      // is in the inbox, and undone if it never gets there.
      let accepted = false;
      try {
        accepted = await acceptDelivery(ctx, entry, { onPersisted: claim?.persist });
      } finally {
        if (!accepted) claim?.release();
      }
      return c.text(accepted ? "accepted" : "duplicate", 202);
    })
    // For `achq container ssh`: wakes a container for someone who can push to its repo, on the host it's deployed from.
    .post("/wake", zValidator("json", WakeRequest), async (c) => {
      const request = c.req.valid("json");
      const refused = await pusher(c.req.raw, request);
      if (refused instanceof Response) return refused;
      const config = configOf(ctx, request.repo);
      const container = config?.host === request.host ? config.containers.find((x) => x.name === request.container) : undefined;
      if (!container) return c.text("not deployed", 404);

      // Any request wakes it; its health check answers once it's up.
      const result = await reach(ctx.delays, (signal) => ctx.fetch(`${container.url}/`, { signal }), ctx.attemptTimeout);
      if (!result.ok) return c.text(result.error, 504);
      await result.res.body?.cancel();
      return c.text("awake");
    })
    // For `achq repo install` and `uninstall`: whether the config's source is installed on the repo, which only the App's key can tell.
    .post("/installation", zValidator("json", InstallationRequest), async (c) => {
      const request = c.req.valid("json");
      const host = await pusher(c.req.raw, request);
      if (host instanceof Response) return host;
      const found = await host.installation(request.repo, request.source);
      return found ? c.json(found) : c.text("unknown source", 404);
    })
    // For `achq repo install`, once you've fixed what failed its deploy: deploys the repo again, as installing it does.
    .post("/deploy", zValidator("json", RepoRequest), async (c) => {
      const request = c.req.valid("json");
      const refused = await pusher(c.req.raw, request);
      if (refused instanceof Response) return refused;
      const event: DeployerEvent = { delivery: `deploy-${crypto.randomUUID()}`, type: "deploy.requested", host: request.host, deploy: [request.repo], uninstall: [] };
      // Through the inbox, as an install event goes, so a deployer that's asleep or restarting still gets it.
      await acceptDelivery(ctx, { to: "deployer", event });
      return c.text("accepted", 202);
    });

  /** A request a container signed: the body names the container, and the signature proves it's that container. */
  const fromContainer = createMiddleware<{ Variables: { config: RouterRepoConfig; container: Container } }>(async (c, next) => {
    const identity = CredentialsRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!identity.success) return c.text("bad request", 400);
    const { repo, container: name } = identity.data;
    if (!(await isSigned(c, containerSecret(ctx.key, repo, name), ctx.now()))) return c.text("bad signature", 401);
    const config = configOf(ctx, repo);
    const container = config?.containers.find((x) => x.name === name);
    if (!config || !container) return c.text("no such container", 404);
    c.set("config", config);
    c.set("container", container);
    await next();
  });

  // Credentials are only for achq's own services, on the port the public can't reach.
  const privateApp = http
    .service(ctx.log)
    .route("/admin", admin)
    .post("/credentials", fromContainer, async (c) => {
      const { config, container } = c.var;
      const credentials = await mint(ctx, container.policies, config.repo);
      const channels = await mintClients(ctx, config, container.name);
      return c.json({ credentials, channels } satisfies CredentialsResponse);
    });

  return {
    publicFetch: publicApp.fetch,
    privateFetch: privateApp.fetch,
    /** Loads config and claims from the store, then replays the inbox in the background. Call before serving. */
    start: async () => {
      for (const config of await ctx.store.repos.all()) ctx.repos.set(repoName.key(config.repo), config);
      for (const name of await ctx.store.claims.list()) {
        const repoClaims = await ctx.store.claims.read(name);
        if (repoClaims) ctx.claims.set(repoName.fromFile(name), repoClaims);
      }
      await replay(ctx);
    },
    replay: () => replay(ctx),
    settled: () => settled(ctx),
  };
};

export type Router = ReturnType<typeof createRouter>;

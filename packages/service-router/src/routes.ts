import { type ChannelProvider, type CredentialsResponse, type DeployerEvent, repoName } from "@achq/core";
import { DEPLOYER_SERVICE, deployerClient } from "@achq/core/clients/deployer";
import { CredentialsRequest, type RepoRequest, type RouterRepoConfig } from "@achq/core/protocol";
import { routerAdminRoutes as adminRoutes } from "@achq/core/routes/router-admin";
import { routerContainerRoutes as containerRoutes } from "@achq/core/routes/router-container";
import { routerPublicRoutes as publicRoutes } from "@achq/core/routes/router-public";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { isSigned, signedBy } from "@achq/core/signing";
import { handler, http, HttpError } from "@achq/utils/http";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { claimsOf, configOf, type RouterContext } from "./context.ts";
import { mint, mintClients, validate } from "./features/credentials.ts";
import { acceptDelivery, type Reservation, listFailed, replayFailed, reserveClaims, targetsFor } from "./features/deliveries.ts";
import { reach, toDeployer } from "./features/reach.ts";
import type { InboxEntry } from "./store.ts";

/** What a channel's delivery ID may be. Stores encode names themselves, so this only bounds the size and characters of an ID a stranger sends. */
const DELIVERY_ID = /^[\w.-]{1,200}$/;

type Container = RouterRepoConfig["containers"][number];

/** A deployer's refusal keeps its status and body, and one that never answered is a 504, as the deployer client throws them. Anything else is the service's to answer. */
const deployerRefusal = (error: Error) => {
  if (error instanceof HttpError && error.service === DEPLOYER_SERVICE) return new Response(error.body, { status: error.status, headers: { "content-type": "text/plain; charset=UTF-8" } });
  throw error;
};

/** `@achq/core/routes/router-admin`: for the deployer and the infra CLI, on both ports, signed with the admin secret. */
const adminApp = (ctx: RouterContext) => {
  /** The deployer, woken as it's called. What a forwarded route answers is what it decoded, encoded again. */
  const deployer = deployerClient(toDeployer(ctx));
  const admin = new OpenAPIHono();
  // On its own: chained, `use` returns a plain Hono, which has no `openapi`.
  admin.use(signedBy(adminSecret(ctx.env.key), ctx.now));
  admin.onError(deployerRefusal);
  admin.openapi(adminRoutes.listRepos, (c) => c.json([...ctx.repos.values()], 200));
  admin.openapi(
    adminRoutes.putRepo,
    handler(adminRoutes.putRepo, async (c) => {
      const { owner, name } = c.req.valid("param");
      const repo = `${owner}/${name}`;
      const config = c.req.valid("json");
      if (!repoName.same(config.repo, repo)) return c.text("bad config", 400);
      // Written before it's live, so what's served is always what a restart would load.
      await ctx.store.repos.write(repoName.key(repo), config);
      ctx.repos.set(repoName.key(repo), config);
      return c.body(null, 204);
    }),
  );
  admin.openapi(
    adminRoutes.deleteRepo,
    handler(adminRoutes.deleteRepo, async (c) => {
      const { owner, name } = c.req.valid("param");
      const repo = `${owner}/${name}`;
      // Claims are kept: reinstalling brings everything back as it was.
      await ctx.store.repos.remove(repoName.key(repo));
      ctx.repos.delete(repoName.key(repo));
      return c.body(null, 204);
    }),
  );
  admin.openapi(adminRoutes.mint, async (c) => {
    const { policies, repo } = c.req.valid("json");
    return c.json(await mint(ctx, policies, repo), 200);
  });
  admin.openapi(adminRoutes.validate, async (c) => {
    const { policies, repo } = c.req.valid("json");
    return c.json({ problems: await validate(ctx, policies, repo) }, 200);
  });
  admin.openapi(adminRoutes.installed, async (c) => c.json(await ctx.codeHost.installed(), 200));
  admin.openapi(adminRoutes.sources, async (c) => c.json((await Promise.all(ctx.channelProviders.map((channel) => channel.sources()))).flat(), 200));
  admin.openapi(adminRoutes.sync, async (c) => c.json(await deployer.sync({ body: c.req.valid("json") }), 202));
  admin.openapi(adminRoutes.syncStatus, async (c) => c.json(await deployer.syncStatus({ params: c.req.valid("param") }), 200));
  admin.openapi(adminRoutes.status, async (c) => c.json(await deployer.status(), 200));
  admin.openapi(adminRoutes.deployerVersion, async (c) => c.json(await deployer.version(), 200));
  admin.openapi(adminRoutes.failed, async (c) => c.json(await listFailed(ctx), 200));
  admin.openapi(adminRoutes.replay, async (c) => c.json(await replayFailed(ctx), 200));
  return admin;
};

/** `@achq/core/routes/router-public`: for channels' webhooks and the repo CLI, on the public port. */
const publicApp = (ctx: RouterContext) => {
  const deployer = deployerClient(toDeployer(ctx));
  /**
   * The response refusing the request, unless its bearer token can push to the
   * repo on the code host. Checked before saying anything about the repo, so
   * strangers learn nothing.
   */
  const refusal = async (c: Context, request: RepoRequest) => {
    const token = http.bearerToken(c.req.raw);
    if (!token) return c.text("missing token", 401);
    if (!repoName.pattern.test(request.repo)) return c.text("bad request", 400);
    if (!(await ctx.codeHost.canPush(request.repo, token))) return c.text("no push access", 403);
  };

  /** The channel whose signature a delivery carries, and the source it's from. */
  const verifiedChannel = async (headers: Headers, body: string): Promise<{ channel: ChannelProvider; source: string } | undefined> => {
    for (const channel of ctx.channelProviders) {
      const source = await channel.verify(headers, body);
      if (source) return { channel, source };
    }
  };

  const pub = new OpenAPIHono();
  pub.onError(deployerRefusal);
  pub
    .openapi(publicRoutes.webhook, async (c) => {
      const body = await c.req.text();
      const headers = c.req.raw.headers;
      const found = await verifiedChannel(headers, body);
      if (!found) return c.text("bad signature", 401);
      const parsed = found.channel.parse(found.source, headers, body);
      if (!parsed) return c.text("ignored", 200);
      if (!DELIVERY_ID.test(parsed.event.delivery)) return c.text("bad delivery id", 400);

      let entry: InboxEntry;
      let claim: Reservation | undefined;
      if (parsed.to === "deployer") {
        // A repo isn't deployed until its install is handled, so installs always go through; a push only for a repo that's deployed.
        const deployed = (repos: string[]) => repos.filter((repo) => configOf(ctx, repo));
        // onlyIfDeployed is the router's to act on, so it isn't forwarded.
        const { onlyIfDeployed, ...decided } = parsed.event;
        const forDeployer: DeployerEvent = onlyIfDeployed ? { ...decided, deploy: deployed(decided.deploy), uninstall: deployed(decided.uninstall) } : decided;
        if (!forDeployer.deploy.length && !forDeployer.uninstall.length) return c.text("no match", 200);
        entry = { to: "deployer", event: forDeployer };
      } else {
        const { event } = parsed;
        const targets = targetsFor(found.channel, event, configOf(ctx, event.repo), claimsOf(ctx, event.repo));
        if (!targets.length) return c.text("no match", 200);
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
    // For `achq container ssh` and `resume`: wakes a container for someone who can push to its repo, then asks the deployer how to reach it.
    .openapi(publicRoutes.reach, async (c) => {
      const request = c.req.valid("json");
      const refused = await refusal(c, request);
      if (refused) return refused;
      const container = configOf(ctx, request.repo)?.containers.find((x) => x.name === request.container);
      if (!container) return c.text("not deployed", 404);

      // Any request wakes it; its health check answers once it's up.
      const result = await reach(ctx.delays, (signal) => ctx.fetch(`${container.url}/`, { signal }), ctx.attemptTimeout);
      if (!result.ok) return c.text(result.error, 504);
      await result.res.body?.cancel();
      // Only the deployer has the container provider's credentials, which finding the container can take.
      return c.json(await deployer.shell({ body: request }), 200);
    })
    // For `achq repo install` and `uninstall`: whether the config's source is installed on the repo, which only the App's key can tell.
    .openapi(publicRoutes.installation, async (c) => {
      const request = c.req.valid("json");
      const refused = await refusal(c, request);
      if (refused) return refused;
      const found = await ctx.codeHost.installation(request.repo, request.source);
      return found ? c.json(found, 200) : c.text("unknown source", 404);
    })
    // For `achq repo install`, once you've fixed what failed its deploy: deploys the repo again, as installing it does.
    .openapi(publicRoutes.deploy, async (c) => {
      const request = c.req.valid("json");
      const refused = await refusal(c, request);
      if (refused) return refused;
      const event: DeployerEvent = { delivery: `deploy-${crypto.randomUUID()}`, type: "deploy.requested", deploy: [request.repo], uninstall: [] };
      // Through the inbox, as an install event goes, so a deployer that's asleep or restarting still gets it.
      await acceptDelivery(ctx, { to: "deployer", event });
      return c.text("accepted", 202);
    });
  return pub;
};

type ContainerEnv = { Variables: { config: RouterRepoConfig; container: Container } };

/** `@achq/core/routes/router-container`: credentials are only for achq's own services, on the port the public can't reach. */
const containerApp = (ctx: RouterContext) => {
  /** A request a container signed: the body names the container, and the signature proves it's that container. Read as text first, so the signature covers the bytes it sent. */
  const fromContainer = createMiddleware<ContainerEnv>(async (c, next) => {
    await c.req.text();
    const identity = CredentialsRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!identity.success) return c.text("bad request", 400);
    const { repo, container: name } = identity.data;
    if (!(await isSigned(c, containerSecret(ctx.env.key, repo, name), ctx.now()))) return c.text("bad signature", 401);
    const config = configOf(ctx, repo);
    const container = config?.containers.find((x) => x.name === name);
    if (!config || !container) return c.text("no such container", 404);
    c.set("config", config);
    c.set("container", container);
    await next();
  });

  const forContainers = new OpenAPIHono<ContainerEnv>();
  forContainers.use(containerRoutes.credentials.path, fromContainer);
  forContainers.openapi(
    containerRoutes.credentials,
    handler<typeof containerRoutes.credentials, ContainerEnv>(containerRoutes.credentials, async (c) => {
      const { config, container } = c.var;
      const credentials = await mint(ctx, container.policies, config.repo);
      const channels = await mintClients(ctx, config, container.name);
      return c.json({ credentials, channels } satisfies CredentialsResponse, 200);
    }),
  );

  return forContainers;
};

/**
 * The router's apps, one per declaration in `@achq/core/routes/`, and how
 * they're mounted: the admin routes under `/admin` on both ports, the public
 * routes on the public port, and the containers' on the private one.
 */
export const routes = (ctx: RouterContext) => {
  const admin = adminApp(ctx);
  const pub = publicApp(ctx);
  const container = containerApp(ctx);
  return {
    admin,
    public: pub,
    container,
    publicFetch: http.service(ctx.log).route("/admin", admin).route("/", pub).fetch,
    privateFetch: http.service(ctx.log).route("/admin", admin).route("/", container).fetch,
  };
};

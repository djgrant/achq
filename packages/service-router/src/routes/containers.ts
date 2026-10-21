import { type ChannelCredential, type CredentialsResponse, threadKey } from "@achq/core";
import { ClaimRequest, CredentialsRequest, type RouterRepoConfig } from "@achq/core/protocol";
import { containerSecret } from "@achq/core/secrets";
import { isSigned } from "@achq/core/signing";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { configOf, type RouterContext } from "../context.ts";
import { mint } from "../policies.ts";
import { repoFile, repoKey } from "../store.ts";

type Container = RouterRepoConfig["containers"][number];
type ChannelSource = { channel: string; source: string };

const channelSourcesOf = (config: RouterRepoConfig, container: string): ChannelSource[] => {
  const sources = new Map<string, ChannelSource>();
  for (const w of config.workspaces) {
    const { channel, source } = w.threads;
    if (w.container === container) sources.set(`${channel}\n${source}`, { channel, source });
  }
  return [...sources.values()];
};

const channelOf = (ctx: RouterContext, id: string) => {
  const found = ctx.channelProviders.find((c) => c.id === id);
  if (!found) throw new Error(`No channel "${id}"`);
  return found;
};

/** One client credential per (channel, source) the container's workspaces select threads from. */
const mintClients = (ctx: RouterContext, config: RouterRepoConfig, container: string): Promise<ChannelCredential[]> =>
  Promise.all(channelSourcesOf(config, container).map(({ channel, source }) => channelOf(ctx, channel).mintClient(source, config.repo)));

/** A request a container signed: the body names the container, and the signature proves it's that container. */
const fromContainer = (ctx: RouterContext) =>
  createMiddleware<{ Variables: { config: RouterRepoConfig; container: Container } }>(async (c, next) => {
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

/** For containers, over the private network. */
export const containers = (ctx: RouterContext) =>
  new Hono()
    .post("/credentials", fromContainer(ctx), async (c) => {
      const { config, container } = c.var;
      const credentials = await mint(ctx, container.policies, config.repo);
      const channels = await mintClients(ctx, config, container.name);
      return c.json({ credentials, channels } satisfies CredentialsResponse);
    })
    .post("/claims", fromContainer(ctx), zValidator("json", ClaimRequest), async (c) => {
      const { config } = c.var;
      const claim = c.req.valid("json");
      if (!config.workspaces.some((w) => w.name === claim.workspace && w.container === claim.container)) return c.text("no such workspace", 404);
      const repo = repoKey(config.repo);
      const repoClaims = ctx.claims.get(repo) ?? {};
      const thread = threadKey(claim.thread);
      repoClaims[thread] = { ...repoClaims[thread], [claim.container]: claim.workspace };
      ctx.claims.set(repo, repoClaims);
      await ctx.store.claims.write(repoFile(repo), repoClaims);
      return c.body(null, 204);
    });

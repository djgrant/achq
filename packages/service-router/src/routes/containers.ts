// Containers asking for credentials and claiming threads. Each request names
// its container in the body, and is signed with that container's secret.
import {
  type ChannelCredential,
  type ClaimRequest,
  type CredentialsRequest,
  type CredentialsResponse,
  type RouterRepoConfig,
  threadKey,
} from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { verifySigned } from "@achq/core/signing";
import { jsonResponse, noContent, parseBody, type Schema, textResponse } from "@achq/utils/http";
import { configOf, type RouterContext } from "../context.ts";
import { mint } from "../policies.ts";
import { claimRequestSchema, containerIdentitySchema } from "../requests.ts";
import { repoFile, repoKey } from "../store.ts";

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

type Container = RouterRepoConfig["containers"][number];
type FromContainer<T> = { error: Response } | { request: T; config: RouterRepoConfig; container: Container };

/**
 * A container-signed request: the body names the container, and the signature
 * proves it's that container. Only then is the rest of the body checked
 * against `schema`. A response for a request that isn't one.
 */
const fromContainer = async <T extends CredentialsRequest>(ctx: RouterContext, req: Request, path: string, schema: Schema<T>): Promise<FromContainer<T>> => {
  const body = await req.text();
  const identity = parseBody(containerIdentitySchema, body);
  if (!identity) return { error: textResponse("bad request", 400) };
  if (!verifySigned(containerSecret(ctx.key, identity.repo, identity.container), "POST", path, body, req.headers, ctx.now()))
    return { error: textResponse("bad signature", 401) };
  const config = configOf(ctx, identity.repo);
  const container = config?.containers.find((c) => c.name === identity.container);
  if (!config || !container) return { error: textResponse("no such container", 404) };
  const parsed = schema.safeParse(identity);
  if (!parsed.success) return { error: textResponse("bad request", 400) };
  return { request: parsed.data, config, container };
};

export const credentials = async (ctx: RouterContext, req: Request) => {
  const found = await fromContainer(ctx, req, "/credentials", containerIdentitySchema);
  if ("error" in found) return found.error;
  const { config, container } = found;
  const credentials = await mint(ctx, container.policies, config.repo);
  const channels = await mintClients(ctx, config, container.name);
  return jsonResponse({ credentials, channels } satisfies CredentialsResponse);
};

const recordClaim = async (ctx: RouterContext, config: RouterRepoConfig, request: ClaimRequest) => {
  const repo = repoKey(config.repo);
  const repoClaims = ctx.claims.get(repo) ?? {};
  const thread = threadKey(request.thread);
  repoClaims[thread] = { ...repoClaims[thread], [request.container]: request.workspace };
  ctx.claims.set(repo, repoClaims);
  await ctx.store.claims.write(repoFile(repo), repoClaims);
};

export const claim = async (ctx: RouterContext, req: Request) => {
  const found = await fromContainer(ctx, req, "/claims", claimRequestSchema);
  if ("error" in found) return found.error;
  const { request, config } = found;
  if (!config.workspaces.some((w) => w.name === request.workspace && w.container === request.container)) return textResponse("no such workspace", 404);
  await recordClaim(ctx, config, request);
  return noContent();
};

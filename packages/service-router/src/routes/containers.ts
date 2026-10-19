import { type ChannelCredential, type ClaimRequest, type CredentialsRequest, type RouterRepoConfig, threadKey } from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { verifySigned } from "@achq/core/signing";
import { mint } from "../access.ts";
import { configOf, type RouterContext } from "../context.ts";
import { json, noContent, parse, text } from "../http.ts";
import { repoFile } from "../store.ts";

/** One client credential per (channel, source) the container's workspaces select threads from. */
const mintClients = async (ctx: RouterContext, config: RouterRepoConfig, container: string): Promise<ChannelCredential[]> => {
  const sources = new Map<string, { channel: string; source: string }>();
  for (const w of config.workspaces) {
    const { channel, source } = w.threads;
    if (w.container === container && typeof source === "string") sources.set(`${channel}\n${source}`, { channel, source });
  }
  return Promise.all(
    [...sources.values()].map(({ channel, source }) => {
      const found = ctx.channels.find((c) => c.id === channel);
      if (!found) throw new Error(`No channel "${channel}"`);
      return found.mintClient(source, config.repo);
    }),
  );
};

/** A container-signed request: the body names the container, and the signature proves it's that container. */
const fromContainer = async <T extends { repo: string; container: string }>(ctx: RouterContext, req: Request, path: string) => {
  const body = await req.text();
  const request = parse<T>(body);
  if (typeof request?.repo !== "string" || typeof request.container !== "string") return { error: text("bad request", 400) };
  if (!verifySigned(containerSecret(ctx.key, request.repo, request.container), "POST", path, body, req.headers, ctx.now())) return { error: text("bad signature", 401) };
  const config = configOf(ctx, request.repo);
  const container = config?.containers.find((c) => c.name === request.container);
  if (!config || !container) return { error: text("no such container", 404) };
  return { request: request as T, config, container };
};

export const credentials = async (ctx: RouterContext, req: Request) => {
  const found = await fromContainer<CredentialsRequest>(ctx, req, "/credentials");
  if ("error" in found) return found.error;
  const { config, container } = found;
  const credentials = await mint(ctx, container.policies, config.repo);
  const channels = await mintClients(ctx, config, container.name);
  // `provider` is what containers built before credentials named `access` and `channel` read. It can go once every container's image is rebuilt.
  return json({ credentials: credentials.map((c) => ({ ...c, provider: c.access })), channels: channels.map((c) => ({ ...c, provider: c.channel })) });
};

export const claim = async (ctx: RouterContext, req: Request) => {
  const found = await fromContainer<ClaimRequest>(ctx, req, "/claims");
  if ("error" in found) return found.error;
  const { request, config } = found;
  if (!request.thread || typeof request.thread.channel !== "string" || typeof request.thread.id !== "string") return text("bad request", 400);
  if (!config.workspaces.some((w) => w.name === request.workspace && w.container === request.container)) return text("no such workspace", 404);
  const repo = config.repo.toLowerCase();
  const repoClaims = ctx.claims.get(repo) ?? {};
  const thread = threadKey(request.thread);
  repoClaims[thread] = { ...repoClaims[thread], [request.container]: request.workspace };
  ctx.claims.set(repo, repoClaims);
  await ctx.store.write("claims", repoFile(repo), repoClaims);
  return noContent();
};

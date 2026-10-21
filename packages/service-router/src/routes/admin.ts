import { repoName } from "@achq/core";
import { MintRequest, RouterRepoConfig, ValidateRequest } from "@achq/core/protocol";
import { adminSecret } from "@achq/core/secrets";
import { signedBy } from "@achq/core/signing";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { REPO_PATH } from "../constants.ts";
import type { RouterContext } from "../context.ts";
import { listFailed, replayFailed } from "../failed.ts";
import { mint, validate } from "../policies.ts";
import { fetchSigned, reach } from "../reach.ts";
import { repoFile } from "../store.ts";

/** JSON unless it says otherwise. */
const relay = async (res: Response) =>
  new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });

const toDeployer = async (ctx: RouterContext, method: string, path: string, body?: string) => {
  const url = `${ctx.deployerUrl}${path}`;
  const result = await reach(ctx.delays, (signal) => fetchSigned(ctx, adminSecret(ctx.key), method, url, body, signal));
  return result.ok ? relay(result.res) : new Response(result.error, { status: 504 });
};

/** For the deployer and the infra CLI, on both ports, signed with the admin secret. */
export const admin = (ctx: RouterContext) =>
  new Hono()
    .use(signedBy(adminSecret(ctx.key), ctx.now))
    .get("/repos", (c) => c.json([...ctx.repos.values()]))
    .put(REPO_PATH, zValidator("json", RouterRepoConfig), async (c) => {
      const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
      const config = c.req.valid("json");
      if (repoName.key(config.repo) !== repoName.key(repo)) return c.text("bad config", 400);
      // Written before it's live, so what's served is always what a restart would load.
      await ctx.store.repos.write(repoFile(repo), config);
      ctx.repos.set(repoName.key(repo), config);
      return c.body(null, 204);
    })
    .delete(REPO_PATH, async (c) => {
      const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
      // Claims are kept: reinstalling brings everything back as it was.
      await ctx.store.repos.remove(repoFile(repo));
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
    .post("/sync", async (c) => toDeployer(ctx, "POST", "/sync", await c.req.text()))
    .get("/status", () => toDeployer(ctx, "GET", "/status"))
    .get("/failed", async (c) => c.json(await listFailed(ctx)))
    .post("/failed/replay", async (c) => c.json(await replayFailed(ctx)));

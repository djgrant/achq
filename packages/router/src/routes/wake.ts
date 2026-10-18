import type { WakeRequest } from "@achq/core";
import { REPO, USER_AGENT } from "../constants.ts";
import { configOf, type RouterContext } from "../context.ts";
import { parse, text } from "../http.ts";
import { reach } from "../reach.ts";

const canPush = async (ctx: RouterContext, repo: string, token: string) => {
  const res = await ctx.fetch(`${ctx.githubApi}/repos/${repo}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": USER_AGENT },
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { permissions?: { push?: boolean } };
  return data.permissions?.push === true;
};

/** For `achq ssh`: wakes a container for someone who can push to its repo. */
export const wake = async (ctx: RouterContext, req: Request) => {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return text("missing token", 401);
  const request = parse<WakeRequest>(await req.text());
  if (typeof request?.repo !== "string" || !REPO.test(request.repo) || typeof request.container !== "string") return text("bad request", 400);
  // Checked before saying whether the repo is deployed, so strangers learn nothing.
  if (!(await canPush(ctx, request.repo, token))) return text("no push access", 403);
  const container = configOf(ctx, request.repo)?.containers.find((c) => c.name === request.container);
  if (!container) return text("not deployed", 404);
  const result = await reach(ctx, (signal) => ctx.fetch(`${container.url}/`, { signal }), ctx.attemptTimeout);
  if (!result.ok) return text(result.error, 504);
  await result.res.body?.cancel();
  return text("awake");
};

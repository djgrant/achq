import { HttpError } from "@achq/utils/http";
import type { DeployerContext } from "./context.ts";

const NOT_FOUND = 404;

/** Takes `repo` out of the router; one the router doesn't have is already out. */
const removeFromRouter = async (ctx: DeployerContext, repo: string) => {
  try {
    await ctx.router.deleteRepo(repo);
  } catch (error) {
    if (!(error instanceof HttpError && error.status === NOT_FOUND)) throw error;
  }
};

/** Takes `repo` out of the router. Run one per repo at a time. */
export const uninstall = async (ctx: DeployerContext, host: string, repo: string, dryRun: boolean) => {
  if (dryRun) return;
  const previous = await ctx.store.get(repo);
  await removeFromRouter(ctx, repo);
  // Containers and volumes are kept, asleep. Reinstalling brings it all back.
  await ctx.store.put({ ...previous, error: undefined, warnings: undefined, host, repo, state: "uninstalled", at: ctx.now().toISOString() });
  ctx.log(`${repo}: uninstalled`);
};

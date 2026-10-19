import { RouterError } from "./clients/router.ts";
import type { DeployerContext } from "./context.ts";

/** Takes `repo` out of the router. Run one per repo at a time. */
export const uninstall = async (ctx: DeployerContext, host: string, repo: string, dryRun: boolean) => {
  const previous = await ctx.store.get(repo);
  if (dryRun) return;
  try {
    await ctx.router.deleteRepo(repo);
  } catch (error) {
    if (!(error instanceof RouterError && error.status === 404)) throw error;
  }
  // Containers and volumes are kept, asleep. Reinstalling brings it all back.
  await ctx.store.put({ ...previous, error: undefined, warnings: undefined, host, repo, state: "uninstalled", at: ctx.now().toISOString() });
  ctx.log(`${repo}: uninstalled`);
};

import { RouterError } from "./clients/router.ts";
import type { DeployerContext } from "./context.ts";
import type { StoredRecord } from "./store.ts";

/** Takes `repo` out of the router. Run one per repo at a time. */
export const uninstall = async (ctx: DeployerContext, repo: string, source: string | undefined, dryRun: boolean) => {
  const previous = await ctx.store.get(repo);
  if (dryRun) return;
  try {
    await ctx.router.deleteRepo(repo);
  } catch (error) {
    if (!(error instanceof RouterError && error.status === 404)) throw error;
  }
  // Containers and volumes are kept, asleep. Reinstalling brings it all back.
  const { error: _error, warnings: _warnings, ...rest } = previous ?? ({} as Partial<StoredRecord>);
  await ctx.store.put({ ...rest, repo, source: source ?? previous?.source ?? "", state: "uninstalled", at: ctx.now().toISOString() });
  ctx.log(`${repo}: uninstalled`);
};

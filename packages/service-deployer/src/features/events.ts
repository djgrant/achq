import type { DeployerEnvelope } from "@achq/core";
import type { DeployerContext } from "../context.ts";
import { deploy, uninstall } from "./deploy.ts";

/** Deploys and uninstalls what a repo event names. False for a delivery it had already handled. */
export const handleEvent = async (ctx: DeployerContext, { event }: DeployerEnvelope) => {
  // Claimed synchronously, so a concurrent duplicate sees it before either awaits.
  if (ctx.inFlight.has(event.delivery)) return false;
  ctx.inFlight.add(event.delivery);
  try {
    if (await ctx.store.handled(event.delivery)) return false;
    // One by one: each repo gets its own deploy and its own ACHQ_STATUS.
    for (const repo of event.deploy) await deploy(ctx, repo);
    for (const repo of event.uninstall) await uninstall(ctx, repo);
    // Marked only once handled, so a crash part-way lets the router's replay finish the job.
    await ctx.store.markHandled(event.delivery);
    return true;
  } finally {
    ctx.inFlight.delete(event.delivery);
  }
};

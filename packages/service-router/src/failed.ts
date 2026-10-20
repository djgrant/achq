// Deliveries some target never answered, kept in `failed/`: listed for
// `achq status`, and put back in the inbox by `achq replay`.
import type { FailedDelivery, ReplayResult } from "@achq/core";
import { configOf, type RouterContext } from "./context.ts";
import { acceptDelivery, type FailedEntry, targetLabel } from "./inbox.ts";
import type { Target } from "./targets.ts";

type FailedTarget = FailedEntry["targets"][number];

const describeFailed = ({ event, targets }: FailedEntry): FailedDelivery => ({
  delivery: event.delivery,
  type: event.type,
  ...(event.repo && { repo: event.repo }),
  ...(event.thread && { thread: event.thread }),
  targets: targets.map((t) => ({ target: targetLabel(t), error: t.error })),
});

export const listFailed = async (ctx: RouterContext): Promise<FailedDelivery[]> => {
  const entries = await Promise.all((await ctx.store.failed.list()).map((delivery) => ctx.store.failed.read(delivery)));
  return entries.flatMap((entry) => (entry ? [describeFailed(entry)] : []));
};

/**
 * Where a failed target is now: a container at its current URL, with the
 * config the router holds now. None for a repo or container that's gone.
 */
const currentTarget = (ctx: RouterContext, { error: _, ...target }: FailedTarget): Target[] => {
  if (target.kind === "deployer") return [target];
  const config = configOf(ctx, target.repo);
  const container = config?.containers.find((c) => c.name === target.container);
  return config && container ? [{ ...target, url: container.url, commit: config.commit }] : [];
};

/** Puts every failed delivery back in the inbox, for the targets that failed, and drops ones with none left. */
export const replayFailed = async (ctx: RouterContext): Promise<ReplayResult> => {
  const result: ReplayResult = { replayed: [], dropped: [] };
  for (const delivery of await ctx.store.failed.list()) {
    const entry = await ctx.store.failed.read(delivery);
    if (!entry || ctx.inFlight.has(delivery)) continue;
    const targets = entry.targets.flatMap((t) => currentTarget(ctx, t));
    if (!targets.length) {
      await ctx.store.failed.remove(delivery);
      result.dropped.push(delivery);
      continue;
    }
    // Out of failed/ only once it's in the inbox, and before it can fail again.
    await acceptDelivery(ctx, { event: entry.event, targets, ...(entry.told && { told: true }) }, { onPersisted: () => ctx.store.failed.remove(delivery) });
    result.replayed.push(delivery);
  }
  return result;
};

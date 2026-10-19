import type { ChannelEvent, ContainerEnvelope, DeployerEnvelope } from "@achq/core";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import type { RouterContext } from "./context.ts";
import { message } from "./errors.ts";
import { reach, signed } from "./reach.ts";
import type { Target } from "./targets.ts";

/** What's on the volume for each accepted delivery until every target has answered. */
export type InboxEntry = { event: ChannelEvent; targets: Target[] };
export type FailedEntry = InboxEntry & { targets: (Target & { error: string })[] };

const send = (ctx: RouterContext, target: Target, entry: InboxEntry) => async (signal?: AbortSignal) => {
  if (target.kind === "deployer") {
    const { event } = entry;
    // targetsFor only picks the deployer for installation and configChanged events, which name their host.
    if (event.host === undefined) throw new Error(`${event.delivery} isn't one for the deployer`);
    const envelope: DeployerEnvelope = { event };
    const url = `${ctx.deployerUrl}/events`;
    return ctx.fetch(url, signed(ctx, adminSecret(ctx.key), "POST", url, JSON.stringify(envelope), signal));
  }
  const envelope: ContainerEnvelope = { event: entry.event, commit: target.commit };
  const secret = containerSecret(ctx.key, target.repo, target.container);
  return ctx.fetch(`${target.url}/events`, signed(ctx, secret, "POST", `${target.url}/events`, JSON.stringify(envelope), signal));
};

const describe = (t: Target) => (t.kind === "deployer" ? "deployer" : `${t.repo}/${t.container}`);

/** Forwards to every target, then clears the inbox. Targets that never answer go to `failed/`. */
const deliver = async (ctx: RouterContext, entry: InboxEntry) => {
  const { delivery } = entry.event;
  const results = await Promise.all(
    entry.targets.map(async (target) => {
      const result = await reach(ctx, send(ctx, target, entry), ctx.attemptTimeout);
      if (result.ok) await result.res.body?.cancel();
      ctx.log(`${delivery} ${entry.event.type} → ${describe(target)}: ${result.ok ? result.res.status : result.error}`);
      return { target, error: result.ok ? undefined : result.error };
    }),
  );
  const failed = results.flatMap(({ target, error }) => (error ? [{ ...target, error }] : []));
  if (failed.length) await ctx.store.write("failed", delivery, { ...entry, targets: failed } satisfies FailedEntry);
  await ctx.store.remove("inbox", delivery);
};

/** Forwards in the background, keeping the delivery in `inFlight` until it's done. */
export const track = (ctx: RouterContext, entry: InboxEntry) => {
  const { delivery } = entry.event;
  const done = deliver(ctx, entry)
    .catch((e) => ctx.log(`${delivery}: ${message(e)}`))
    .finally(() => ctx.inFlight.delete(delivery));
  ctx.inFlight.set(delivery, done);
};

/** Forwards everything left in the inbox, with the targets it was stored with. */
export const replay = async (ctx: RouterContext) => {
  for (const delivery of await ctx.store.list("inbox")) {
    if (ctx.inFlight.has(delivery)) continue;
    const entry = await ctx.store.read<InboxEntry>("inbox", delivery);
    if (entry) track(ctx, entry);
  }
};

/** Resolves once every delivery being forwarded has finished. */
export const settled = async (ctx: RouterContext) => {
  while (ctx.inFlight.size) await Promise.all(ctx.inFlight.values());
};

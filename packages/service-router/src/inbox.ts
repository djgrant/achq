// Deliveries the router has accepted. Each is on the volume until every target
// has answered, so a crash or restart replays it rather than losing it.
import type { ChannelEvent, ContainerEnvelope, DeployerEnvelope } from "@achq/core";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { errorMessage } from "@achq/utils/errors";
import type { RouterContext } from "./context.ts";
import { fetchSigned, reach, type Try } from "./reach.ts";
import type { Target } from "./targets.ts";
import { tellUnreached } from "./unreached.ts";

/** `told`: the thread has been told its delivery failed, so a failed replay doesn't tell it again. */
export type InboxEntry = { event: ChannelEvent; targets: Target[]; told?: boolean };
export type FailedEntry = Omit<InboxEntry, "targets"> & { targets: (Target & { error: string })[] };

type Endpoint = { url: string; secret: string; body: string };

const targetEndpoint = (ctx: RouterContext, target: Target, { event }: InboxEntry): Endpoint => {
  if (target.kind === "deployer") {
    // targetsFor only picks the deployer for installation and configChanged events, which name their host.
    if (event.host === undefined) throw new Error(`${event.delivery} isn't one for the deployer`);
    return { url: `${ctx.deployerUrl}/events`, secret: adminSecret(ctx.key), body: JSON.stringify({ event } satisfies DeployerEnvelope) };
  }
  const envelope: ContainerEnvelope = { event, commit: target.commit };
  return { url: `${target.url}/events`, secret: containerSecret(ctx.key, target.repo, target.container), body: JSON.stringify(envelope) };
};

/** A bad target throws inside the attempt, so it fails like one that never answers. */
const sendTo =
  (ctx: RouterContext, target: Target, entry: InboxEntry): Try =>
  (signal) => {
    const { url, secret, body } = targetEndpoint(ctx, target, entry);
    return fetchSigned(ctx, secret, "POST", url, body, signal);
  };

export const targetLabel = (t: Target) => (t.kind === "deployer" ? "deployer" : `${t.repo}/${t.container}`);

const deliverTo = async (ctx: RouterContext, target: Target, entry: InboxEntry) => {
  const result = await reach(ctx.delays, sendTo(ctx, target, entry), ctx.attemptTimeout);
  if (result.ok) await result.res.body?.cancel();
  ctx.log(`${entry.event.delivery} ${entry.event.type} → ${targetLabel(target)}: ${result.ok ? result.res.status : result.error}`);
  return { target, error: result.ok ? undefined : result.error };
};

/** Targets that never answer go to `failed/`, and a thread whose containers never answered is told, once. */
const deliver = async (ctx: RouterContext, entry: InboxEntry) => {
  const { delivery } = entry.event;
  const results = await Promise.all(entry.targets.map((target) => deliverTo(ctx, target, entry)));
  const failed = results.flatMap(({ target, error }) => (error ? [{ ...target, error }] : []));
  if (failed.length) {
    const told = entry.told || (await tellUnreached(ctx, entry.event, failed));
    await ctx.store.failed.write(delivery, { ...entry, targets: failed, ...(told && { told }) });
  }
  await ctx.store.inbox.remove(delivery);
};

const track = (ctx: RouterContext, entry: InboxEntry) => {
  const { delivery } = entry.event;
  const done = deliver(ctx, entry)
    .catch((e) => ctx.log(`${delivery}: ${errorMessage(e)}`))
    .finally(() => ctx.inFlight.delete(delivery));
  ctx.inFlight.set(delivery, done);
};

/**
 * Persists a new delivery, then forwards it in the background. False for one
 * already being forwarded. It's claimed in `inFlight` before the write, so a
 * duplicate arriving meanwhile is turned away, and released if the write fails.
 * `onPersisted` runs once it's in the inbox, before it's forwarded.
 */
export const acceptDelivery = async (ctx: RouterContext, entry: InboxEntry, { onPersisted }: { onPersisted?: () => Promise<unknown> } = {}): Promise<boolean> => {
  const { delivery } = entry.event;
  if (ctx.inFlight.has(delivery)) return false;
  ctx.inFlight.set(delivery, Promise.resolve());
  try {
    await ctx.store.inbox.write(delivery, entry);
    await onPersisted?.();
  } catch (e) {
    ctx.inFlight.delete(delivery);
    throw e;
  }
  track(ctx, entry);
  return true;
};

/** Forwards everything left in the inbox, with the targets it was stored with. */
export const replay = async (ctx: RouterContext) => {
  for (const delivery of await ctx.store.inbox.list()) {
    if (ctx.inFlight.has(delivery)) continue;
    const entry = await ctx.store.inbox.read(delivery);
    if (entry) track(ctx, entry);
  }
};

export const settled = async (ctx: RouterContext) => {
  while (ctx.inFlight.size) await Promise.all(ctx.inFlight.values());
};

import { type ChannelEvent, type ChannelProvider, type ContainerEnvelope, type DeployerEnvelope, type FailedDelivery, type ReplayResult, type RouterRepoConfig, threadKey } from "@achq/core";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { errors } from "@achq/utils/errors";
import { configOf, type RouterContext } from "./context.ts";
import { fetchSigned, reach } from "./reach.ts";

export type Target =
  | { kind: "deployer" }
  /**
   * `workspace` is the one that claimed the thread, or would claim it now. It's there for inspecting the inbox.
   * `commit` is the one whose config the router holds, so the container runs the same config.
   */
  | { kind: "container"; repo: string; container: string; url: string; workspace: string; commit: string };

/** Per thread key, per container: the workspace the container says claimed it. */
export type Claims = Record<string, Record<string, string>>;

/** `told`: the thread has been told its delivery failed, so a failed replay doesn't tell it again. */
export type InboxEntry = { event: ChannelEvent; targets: Target[]; told?: boolean };
export type FailedEntry = Omit<InboxEntry, "targets"> & { targets: (Target & { error: string })[] };

export const targetsFor = (channel: ChannelProvider, event: ChannelEvent, config: RouterRepoConfig | undefined, claims: Claims): Target[] => {
  // A repo isn't deployed until its install is handled, so installs always go through.
  if (event.installation) return [{ kind: "deployer" }];
  if (!config) return [];
  if (event.configChanged) return [{ kind: "deployer" }];

  // Only wake a container for something it would act on. It checks again.
  if (!event.actor?.trusted || event.actor.bot || !event.thread) return [];
  if (!config.triggers.some((t) => t.event.channel === channel.id && channel.matchEvent(t.event, event))) return [];

  const thread = { ref: event.thread, labels: event.labels ?? [] };
  const claimed = claims[threadKey(event.thread)] ?? {};
  // Each container is decided on its own: a claim sticks within the container that
  // made it, and doesn't stop another container's workspace claiming the thread too.
  return config.containers.flatMap((c): Target[] => {
    const workspace =
      claimed[c.name] ??
      config.workspaces.find((w) => w.container === c.name && w.threads.channel === channel.id && channel.matchThread(w.threads, thread))?.name;
    return workspace ? [{ kind: "container", repo: config.repo, container: c.name, url: c.url, workspace, commit: config.commit }] : [];
  });
};

const targetLabel = (t: Target) => (t.kind === "deployer" ? "deployer" : `${t.repo}/${t.container}`);

/** Where an event goes for `target`, and what it's signed with. */
const endpointOf = (ctx: RouterContext, target: Target, event: ChannelEvent) => {
  if (target.kind === "deployer") {
    // targetsFor only picks the deployer for installation and configChanged events, which name their host.
    if (event.host === undefined) throw new Error(`${event.delivery} isn't one for the deployer`);
    return { url: `${ctx.deployerUrl}/events`, secret: adminSecret(ctx.key), body: JSON.stringify({ event } satisfies DeployerEnvelope) };
  }
  const envelope = { event, commit: target.commit } satisfies ContainerEnvelope;
  return { url: `${target.url}/events`, secret: containerSecret(ctx.key, target.repo, target.container), body: JSON.stringify(envelope) };
};

/** Replies on the event's thread, as its channel's source, naming the containers among `failed`. Whether it did: a failure to is only logged. */
const tellUnreached = async (ctx: RouterContext, event: ChannelEvent, failed: Target[]) => {
  const containers = failed.flatMap((t) => (t.kind === "container" ? [`\`${t.container}\``] : []));
  const channel = ctx.channelProviders.find((c) => c.id === event.channel);
  if (!containers.length || !channel || !event.thread || !event.repo) return false;
  try {
    const client = channel.client(await channel.mintClient(event.source, event.repo));
    await client.reply(event.thread, `⚠️ This didn't reach the agent: ${containers.join(" and ")} didn't answer. It's kept, and runs when someone replays it with \`achq infra replay\`.`);
    return true;
  } catch (e) {
    ctx.log(`${event.delivery}: couldn't tell ${threadKey(event.thread)} it failed: ${errors.message(e)}`);
    return false;
  }
};

/**
 * Forwards an entry to its targets in the background, waking them if it has
 * to, and keeps it in `inFlight` until it's done. Targets that never answer go
 * to `failed/`, and a thread whose containers never answered is told, once.
 */
const forward = (ctx: RouterContext, entry: InboxEntry) => {
  const { event } = entry;
  const deliver = async () => {
    const results = await Promise.all(
      entry.targets.map(async (target) => {
        // Addressed inside the attempt, so a bad target fails like one that never answers.
        const result = await reach(
          ctx.delays,
          (signal) => {
            const { url, secret, body } = endpointOf(ctx, target, event);
            return fetchSigned(ctx, secret, "POST", url, body, signal);
          },
          ctx.attemptTimeout,
        );
        if (result.ok) await result.res.body?.cancel();
        ctx.log(`${event.delivery} ${event.type} → ${targetLabel(target)}: ${result.ok ? result.res.status : result.error}`);
        return result.ok ? [] : [{ ...target, error: result.error }];
      }),
    );
    const failed = results.flat();
    if (failed.length) {
      const told = entry.told || (await tellUnreached(ctx, event, failed));
      await ctx.store.failed.write(event.delivery, { ...entry, targets: failed, ...(told && { told }) });
    }
    await ctx.store.inbox.remove(event.delivery);
  };
  const done = deliver()
    .catch((e) => ctx.log(`${event.delivery}: ${errors.message(e)}`))
    .finally(() => ctx.inFlight.delete(event.delivery));
  ctx.inFlight.set(event.delivery, done);
};

/**
 * Persists a new delivery, then forwards it in the background. False for one
 * already being forwarded. It's claimed in `inFlight` before the write, so a
 * duplicate arriving meanwhile is turned away, and released if the write fails.
 * `onPersisted` runs once it's in the inbox, before it's forwarded.
 */
export const acceptDelivery = async (ctx: RouterContext, entry: InboxEntry, { onPersisted }: { onPersisted?: () => Promise<unknown> } = {}) => {
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
  forward(ctx, entry);
  return true;
};

/** Forwards everything left in the inbox, with the targets it was stored with. */
export const replay = async (ctx: RouterContext) => {
  for (const delivery of await ctx.store.inbox.list()) {
    if (ctx.inFlight.has(delivery)) continue;
    const entry = await ctx.store.inbox.read(delivery);
    if (entry) forward(ctx, entry);
  }
};

export const settled = async (ctx: RouterContext) => {
  while (ctx.inFlight.size) await Promise.all(ctx.inFlight.values());
};

export const listFailed = async (ctx: RouterContext): Promise<FailedDelivery[]> =>
  (await ctx.store.failed.all()).map(({ event, targets }) => ({
    delivery: event.delivery,
    type: event.type,
    ...(event.repo && { repo: event.repo }),
    ...(event.thread && { thread: event.thread }),
    targets: targets.map((t) => ({ target: targetLabel(t), error: t.error })),
  }));

/** Puts every failed delivery back in the inbox, for the targets that failed, and drops ones with none left. */
export const replayFailed = async (ctx: RouterContext) => {
  const result: ReplayResult = { replayed: [], dropped: [] };
  for (const delivery of await ctx.store.failed.list()) {
    const entry = await ctx.store.failed.read(delivery);
    if (!entry || ctx.inFlight.has(delivery)) continue;
    // Each target where it is now: a container at its current URL, with the config the router holds now. None for a repo or container that's gone.
    const targets = entry.targets.flatMap(({ error: _, ...target }): Target[] => {
      if (target.kind === "deployer") return [target];
      const config = configOf(ctx, target.repo);
      const container = config?.containers.find((c) => c.name === target.container);
      return config && container ? [{ ...target, url: container.url, commit: config.commit }] : [];
    });
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

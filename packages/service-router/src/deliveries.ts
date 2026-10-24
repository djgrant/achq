import { type ChannelEvent, type ChannelProvider, type ContainerEnvelope, type DeployerEnvelope, type DeployerEvent, type FailedDelivery, isRepoEvent, type ReplayResult, repoName, type RouterRepoConfig, threadKey } from "@achq/core";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { errors } from "@achq/utils/errors";
import { configOf, type RouterContext } from "./context.ts";
import { fetchSigned, reach } from "./reach.ts";

/** Where a repo event goes. */
export type DeployerTarget = { kind: "deployer" };
/**
 * Where a channel event goes. `workspace` is the container's workspace the thread is worked in: the one that claimed it, or the first that matches it now. The container works it there.
 * `commit` is the one whose config the router holds, so the container runs the same config.
 */
export type ContainerTarget = { kind: "container"; repo: string; container: string; url: string; workspace: string; commit: string };
export type Target = DeployerTarget | ContainerTarget;

/** Per thread key, per container: the workspace that claimed it. The router is the only one that decides and records claims. */
export type Claims = Record<string, Record<string, string>>;

/** A repo event goes to the deployer, a channel event to containers. `told`: the thread has been told its delivery failed, so a failed replay doesn't tell it again. */
export type InboxEntry = ({ event: DeployerEvent; targets: DeployerTarget[] } | { event: ChannelEvent; targets: ContainerTarget[] }) & { told?: boolean };
export type FailedEntry = { event: DeployerEvent | ChannelEvent; targets: (Target & { error: string })[]; told?: boolean };

const isForDeployer = (entry: InboxEntry): entry is Extract<InboxEntry, { event: DeployerEvent }> => isRepoEvent(entry.event);

export const targetsFor = (channel: ChannelProvider, event: ChannelEvent, config: RouterRepoConfig | undefined, claims: Claims): ContainerTarget[] => {
  if (!config) return [];
  // Only wake a container for something it would act on. It checks again.
  if (!event.actor?.trusted || event.actor.bot || !event.thread) return [];
  if (!config.triggers.some((t) => t.event.channel === channel.id && channel.matchEvent(t.event, event))) return [];

  const thread = { ref: event.thread, labels: event.labels ?? [] };
  const claimed = claims[threadKey(event.thread)] ?? {};
  // Each container is decided on its own: a claim sticks within the container that
  // made it, and doesn't stop another container's workspace claiming the thread too.
  // A claim on a workspace the config no longer has is passed over.
  return config.containers.flatMap((c): ContainerTarget[] => {
    const workspaces = config.workspaces.filter((w) => w.container === c.name && w.threads.channel === channel.id);
    const workspace = workspaces.find((w) => w.name === claimed[c.name]) ?? workspaces.find((w) => channel.matchThread(w.threads, thread));
    return workspace ? [{ kind: "container", repo: config.repo, container: c.name, url: c.url, workspace: workspace.name, commit: config.commit }] : [];
  });
};

export type Reservation = { persist: () => Promise<void>; release: () => void };

/**
 * Claims the event's thread for each container target's workspace, where it
 * isn't already, in memory: synchronously, where its targets are decided, so a
 * concurrent event on the thread is routed by the claim too. `persist` writes
 * the repo's claims to the store once the event is in the inbox; `release`
 * undoes what this reservation set, if it wasn't accepted. None if there's
 * nothing to claim.
 */
export const reserveClaims = (ctx: RouterContext, event: ChannelEvent, targets: ContainerTarget[]): Reservation | undefined => {
  if (!event.repo || !event.thread) return;
  const repo = repoName.key(event.repo);
  const thread = threadKey(event.thread);
  const repoClaims = ctx.claims.get(repo) ?? {};
  const before = repoClaims[thread] ?? {};
  const fresh = targets.filter((t) => before[t.container] !== t.workspace);
  if (!fresh.length) return;
  repoClaims[thread] = { ...before, ...Object.fromEntries(fresh.map((t) => [t.container, t.workspace])) };
  ctx.claims.set(repo, repoClaims);
  return {
    persist: () => ctx.store.claims.write(repoName.file(repo), ctx.claims.get(repo) ?? repoClaims),
    release: () => {
      const now = ctx.claims.get(repo)?.[thread];
      if (!now) return;
      for (const t of fresh) {
        if (now[t.container] !== t.workspace) continue;
        const previous = before[t.container];
        if (previous === undefined) delete now[t.container];
        else now[t.container] = previous;
      }
      if (!Object.keys(now).length) delete ctx.claims.get(repo)![thread];
    },
  };
};

const targetLabel = (t: Target) => (t.kind === "deployer" ? "deployer" : `${t.repo}/${t.container}`);

type Endpoint = { url: string; secret: string; body: string };

/** Each of an entry's targets, and where its event goes for it, and what it's signed with. */
const endpointsOf = (ctx: RouterContext, entry: InboxEntry): { target: Target; endpoint: () => Endpoint }[] => {
  if (isForDeployer(entry)) {
    const body = JSON.stringify({ event: entry.event } satisfies DeployerEnvelope);
    return entry.targets.map((target) => ({ target, endpoint: () => ({ url: `${ctx.deployerUrl}/events`, secret: adminSecret(ctx.key), body }) }));
  }
  const { event } = entry;
  return entry.targets.map((target) => ({
    target,
    endpoint: () => ({
      url: `${target.url}/events`,
      secret: containerSecret(ctx.key, target.repo, target.container),
      body: JSON.stringify({ event, commit: target.commit, workspace: target.workspace } satisfies ContainerEnvelope),
    }),
  }));
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
      endpointsOf(ctx, entry).map(async ({ target, endpoint }) => {
        // Addressed inside the attempt, so a bad target fails like one that never answers.
        const result = await reach(
          ctx.delays,
          (signal) => {
            const { url, secret, body } = endpoint();
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
      const told = entry.told || (!isForDeployer(entry) && (await tellUnreached(ctx, entry.event, failed)));
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
 * `onPersisted` runs once it's in the inbox, before it's forwarded: the event
 * is accepted by then, so if it fails that's only logged, and it's still forwarded.
 */
export const acceptDelivery = async (ctx: RouterContext, entry: InboxEntry, { onPersisted }: { onPersisted?: () => Promise<unknown> } = {}) => {
  const { delivery } = entry.event;
  if (ctx.inFlight.has(delivery)) return false;
  ctx.inFlight.set(delivery, Promise.resolve());
  try {
    await ctx.store.inbox.write(delivery, entry);
  } catch (e) {
    ctx.inFlight.delete(delivery);
    throw e;
  }
  try {
    await onPersisted?.();
  } catch (e) {
    ctx.log(`${delivery}: accepted, but ${errors.message(e)}`);
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

/** The repos an event is about, as `GET /admin/failed` names them. */
const reposOf = (event: DeployerEvent | ChannelEvent) => (isRepoEvent(event) ? [...event.deploy, ...event.uninstall].join(", ") : event.repo);

export const listFailed = async (ctx: RouterContext): Promise<FailedDelivery[]> =>
  (await ctx.store.failed.all()).map(({ event, targets }) => {
    const repo = reposOf(event);
    return {
      delivery: event.delivery,
      type: event.type,
      ...(repo && { repo }),
      ...(!isRepoEvent(event) && event.thread && { thread: event.thread }),
      targets: targets.map((t) => ({ target: targetLabel(t), error: t.error })),
    };
  });

/** Puts every failed delivery back in the inbox, for the targets that failed, and drops ones with none left. */
export const replayFailed = async (ctx: RouterContext) => {
  const result: ReplayResult = { replayed: [], dropped: [] };
  for (const delivery of await ctx.store.failed.list()) {
    const entry = await ctx.store.failed.read(delivery);
    if (!entry || ctx.inFlight.has(delivery)) continue;
    // A repo event goes back to the deployer. A channel event goes to each container where it is now, at its current URL, with the config
    // the router holds now: to none for a repo or container that's gone.
    const { event, told } = entry;
    const again: InboxEntry = isRepoEvent(event)
      ? { event, targets: [{ kind: "deployer" }] }
      : {
          event,
          targets: entry.targets.flatMap(({ error: _, ...target }): ContainerTarget[] => {
            if (target.kind !== "container") return [];
            const config = configOf(ctx, target.repo);
            const container = config?.containers.find((c) => c.name === target.container);
            return config && container ? [{ ...target, url: container.url, commit: config.commit }] : [];
          }),
          ...(told && { told: true }),
        };
    if (!again.targets.length) {
      await ctx.store.failed.remove(delivery);
      result.dropped.push(delivery);
      continue;
    }
    // Out of failed/ only once it's in the inbox, and before it can fail again.
    await acceptDelivery(ctx, again, { onPersisted: () => ctx.store.failed.remove(delivery) });
    result.replayed.push(delivery);
  }
  return result;
};

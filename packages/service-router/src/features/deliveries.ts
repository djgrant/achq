import { type ChannelEvent, type ChannelProvider, type ContainerEnvelope, type DeployerEnvelope, type FailedDelivery, fromTrustedPerson, type ReplayResult, repoName, type RouterRepoConfig, threadKey } from "@achq/core";
import { deployerRoutes } from "@achq/core/routes/deployer";
import { runnerRoutes } from "@achq/core/routes/runner";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { errors } from "@achq/utils/errors";
import { configOf, type RouterContext } from "../context.ts";
import { fetchSigned, reach } from "./reach.ts";
import type { Claims, ContainerTarget, InboxEntry } from "../store.ts";

export const targetsFor = (channel: ChannelProvider, event: ChannelEvent, config: RouterRepoConfig | undefined, claims: Claims) => {
  if (!config) return [];
  // Only wake a container for something it would act on. It checks again.
  if (!fromTrustedPerson(event) || !event.thread) return [];
  if (!config.triggers.some((t) => t.event.channel === channel.id && channel.matchEvent(t.event, event))) return [];

  const thread = { ref: event.thread, labels: event.labels ?? [] };
  const claimed = claims[threadKey(event.thread)] ?? {};
  // Each container is decided on its own: a claim sticks within the container that
  // made it, and doesn't stop another container's workspace claiming the thread too.
  // A claim on a workspace the config no longer has is passed over.
  return config.containers.flatMap((c): ContainerTarget[] => {
    const workspaces = config.workspaces.filter((w) => w.container === c.name && w.threads.channel === channel.id);
    const workspace = workspaces.find((w) => w.name === claimed[c.name]) ?? workspaces.find((w) => channel.matchThread(w.threads, thread));
    return workspace ? [{ repo: config.repo, container: c.name, url: c.url, workspace: workspace.name, commit: config.commit }] : [];
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
export const reserveClaims = (ctx: RouterContext, event: ChannelEvent, targets: ContainerTarget[]) => {
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
    persist: () => ctx.store.claims.write(repo, ctx.claims.get(repo) ?? repoClaims),
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

/** A status from here up, short of a 5xx, means its target refused the event. */
const CLIENT_ERROR = 400;

const containerLabel = (t: ContainerTarget) => `${t.repo}/${t.container}`;

type Endpoint = { url: string; secret: string; body: string };

/** Replies on the event's thread, as its channel's source, naming the containers that never answered. Whether it did: a failure to is only logged. */
const tellUnreached = async (ctx: RouterContext, event: ChannelEvent, failed: ContainerTarget[]) => {
  const containers = failed.map((t) => `\`${t.container}\``);
  const channel = ctx.channelProviders.find((c) => c.id === event.channel);
  if (!channel || !event.thread || !event.repo) return false;
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
 * to, and keeps it in `inFlight` until it's done. Targets that never answer, or
 * refuse it, go to `failed/`, and a thread whose containers never answered is told, once.
 */
const forward = (ctx: RouterContext, entry: InboxEntry) => {
  const { event } = entry;
  /** Sends the event to one target: why it never took it, if it didn't. */
  const send = async (label: string, endpoint: () => Endpoint) => {
    // Addressed inside the attempt, so a bad target fails like one that never answers.
    const result = await reach(
      ctx.delays,
      (signal) => {
        const { url, secret, body } = endpoint();
        return fetchSigned(ctx, secret, "POST", url, body, signal);
      },
      ctx.attemptTimeout,
    );
    ctx.log(`${event.delivery} ${event.type} → ${label}: ${result.ok ? result.res.status : result.error}`);
    if (!result.ok) return result.error;
    const { res } = result;
    // A 4xx answers, but refuses: its target only refuses an event whose signature or shape it doesn't accept, as one a version
    // behind the router does mid-rollout, so the event is kept in failed/ to replay rather than dropped.
    if (res.status >= CLIENT_ERROR) return `refused (${`${res.status} ${await res.text()}`.trim()})`;
    await res.body?.cancel();
  };
  const deliver = async () => {
    if (entry.to === "deployer") {
      const body = JSON.stringify({ event: entry.event } satisfies DeployerEnvelope);
      const error = await send("deployer", () => ({ url: `${ctx.env.deployerUrl}${deployerRoutes.events.path}`, secret: adminSecret(ctx.env.key), body }));
      if (error) await ctx.store.failed.write(event.delivery, { ...entry, error });
    } else {
      const results = await Promise.all(
        entry.targets.map(async (target) => {
          const error = await send(containerLabel(target), () => ({
            url: `${target.url}${runnerRoutes.events.path}`,
            secret: containerSecret(ctx.env.key, target.repo, target.container),
            body: JSON.stringify({ event: entry.event, commit: target.commit, workspace: target.workspace } satisfies ContainerEnvelope),
          }));
          return error ? [{ ...target, error }] : [];
        }),
      );
      const failed = results.flat();
      if (failed.length) {
        const told = entry.told || (await tellUnreached(ctx, entry.event, failed));
        await ctx.store.failed.write(event.delivery, { ...entry, targets: failed, ...(told && { told }) });
      }
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

export const listFailed = async (ctx: RouterContext) =>
  (await ctx.store.failed.all()).map((entry) => {
    const { delivery, type } = entry.event;
    if (entry.to === "deployer") {
      const repo = [...entry.event.deploy, ...entry.event.uninstall].join(", ");
      return { delivery, type, ...(repo && { repo }), targets: [{ target: "deployer", error: entry.error }] };
    }
    const { repo, thread } = entry.event;
    return { delivery, type, ...(repo && { repo }), ...(thread && { thread }), targets: entry.targets.map((t) => ({ target: containerLabel(t), error: t.error })) };
  }) satisfies FailedDelivery[];

/** Puts every failed delivery back in the inbox, for the targets that failed, and drops ones with none left. */
export const replayFailed = async (ctx: RouterContext) => {
  const result: ReplayResult = { replayed: [], dropped: [] };
  for (const delivery of await ctx.store.failed.list()) {
    const entry = await ctx.store.failed.read(delivery);
    if (!entry || ctx.inFlight.has(delivery)) continue;
    // A repo event goes back to the deployer. A channel event goes to each container where it is now, at its current URL, with the config
    // the router holds now: to none for a repo or container that's gone.
    const again: InboxEntry =
      entry.to === "deployer"
        ? { to: "deployer", event: entry.event }
        : {
            to: "containers",
            event: entry.event,
            targets: entry.targets.flatMap(({ error: _, ...target }): ContainerTarget[] => {
              const config = configOf(ctx, target.repo);
              const container = config?.containers.find((c) => c.name === target.container);
              return config && container ? [{ ...target, url: container.url, commit: config.commit }] : [];
            }),
            ...(entry.told && { told: true }),
          };
    if (again.to === "containers" && !again.targets.length) {
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

// Which services an event wakes. Pure: the router's state goes in, targets come out.
import { type Channel, type ChannelEvent, type RouterRepoConfig, threadKey } from "../core/types.ts";

export type Target =
  | { kind: "deployer" }
  /** `workspace` is the one that claimed the thread, or would claim it now; for inspecting the inbox. */
  | { kind: "container"; repo: string; container: string; url: string; workspace: string };

/** Per thread key, per container: the workspace the container says claimed it. */
export type Claims = Record<string, Record<string, string>>;

/**
 * A push the deployer should look at: to the default branch, touching `.achq/`.
 * A truncated commit list can't say what it touched, so it counts.
 */
const redeploys = (event: ChannelEvent) => {
  const { ref, defaultBranch, touchesConfig, truncated } = event.detail;
  return ref === `refs/heads/${defaultBranch}` && (touchesConfig === true || truncated === true);
};

export const targetsFor = (channel: Channel, event: ChannelEvent, config: RouterRepoConfig | undefined, claims: Claims): Target[] => {
  // A repo isn't deployed until its install is handled, so installs always go through.
  if (event.type.startsWith("installation")) return [{ kind: "deployer" }];
  if (!config) return [];
  if (event.type === "push") return redeploys(event) ? [{ kind: "deployer" }] : [];

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
    return workspace ? [{ kind: "container", repo: config.repo, container: c.name, url: c.url, workspace }] : [];
  });
};

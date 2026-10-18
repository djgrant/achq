import type { ChannelEvent, EventEnvelope } from "@achq/core";
import type { Store } from "./store.ts";

/**
 * The repos an installation event adds (`which: "added"`) or removes. The GitHub
 * channel lists them in `detail.added` / `detail.removed`, and every repo the
 * installation covers in `detail.repos` (for suspend and unsuspend).
 */
export const eventRepos = (event: ChannelEvent, which: "added" | "removed"): string[] => {
  const names = (listed: unknown) =>
    Array.isArray(listed)
      ? listed.map((r) => (typeof r === "string" ? r : r && typeof r === "object" && typeof (r as { full_name?: unknown }).full_name === "string" ? (r as { full_name: string }).full_name : undefined))
      : [];
  const all = [...names(event.detail?.[which]), ...names(event.detail?.repos), ...(event.repo ? [event.repo] : [])].filter((r): r is string => Boolean(r));
  return [...new Map(all.map((r) => [r.toLowerCase(), r])).values()];
};

type Actions = {
  deploy: (repo: string, source: string) => Promise<unknown>;
  uninstall: (repo: string, source: string) => Promise<unknown>;
};

/** Handles events the router forwarded. Each returns false for a delivery it had already handled. */
export const createEventHandler = (store: Store, actions: Actions) => {
  const inflight = new Set<string>();

  return async ({ event }: EventEnvelope): Promise<boolean> => {
    // Claimed synchronously, so a concurrent duplicate sees it before either awaits.
    if (inflight.has(event.delivery)) return false;
    inflight.add(event.delivery);
    try {
      if (await store.handled(event.delivery)) return false;
      const [kind, action] = event.type.split(".");
      const install = (kind === "installation" && (action === "created" || action === "unsuspend")) || (kind === "installation_repositories" && action === "added");
      const remove = (kind === "installation" && (action === "deleted" || action === "suspend")) || (kind === "installation_repositories" && action === "removed");
      // One by one: each repo gets its own deploy and its own ACHQ_STATUS.
      if (install) for (const repo of eventRepos(event, "added")) await actions.deploy(repo, event.source);
      else if (remove) for (const repo of eventRepos(event, "removed")) await actions.uninstall(repo, event.source);
      else if (kind === "push" && event.repo) await actions.deploy(event.repo, event.source);
      // Marked only once handled, so a crash part-way lets the router's replay finish the job.
      await store.markHandled(event.delivery);
      return true;
    } finally {
      inflight.delete(event.delivery);
    }
  };
};

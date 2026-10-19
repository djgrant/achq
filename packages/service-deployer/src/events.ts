import type { EventEnvelope } from "@achq/core";
import type { Store } from "./store.ts";

type Actions = {
  deploy: (host: string, repo: string, source: string) => Promise<unknown>;
  uninstall: (host: string, repo: string, source: string) => Promise<unknown>;
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
      // An event queued before events named their host has none: GitHub's channel and repo host share an id. Drop once the router's inbox has drained.
      const host = event.host ?? event.channel;
      // One by one: each repo gets its own deploy and its own ACHQ_STATUS.
      if (event.installation) {
        for (const repo of event.installation.added) await actions.deploy(host, repo, event.source);
        for (const repo of event.installation.removed) await actions.uninstall(host, repo, event.source);
      } else if (event.configChanged && event.repo) await actions.deploy(host, event.repo, event.source);
      // Marked only once handled, so a crash part-way lets the router's replay finish the job.
      await store.markHandled(event.delivery);
      return true;
    } finally {
      inflight.delete(event.delivery);
    }
  };
};

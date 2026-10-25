import type { JsonStore } from "@achq/core";
import type { ContainerTarget } from "./deliveries.ts";

/** An inbox or failed entry as routers kept them before they said where they go: each target said what it was, a deployer event had a `host`, and a failed target its error. */
type UntaggedEntry = {
  to?: undefined;
  event: Record<string, unknown>;
  targets: ({ kind: "deployer"; error?: string } | ({ kind: "container"; error?: string } & ContainerTarget))[];
  told?: boolean;
};

/**
 * Rewrites each entry in an inbox or failed store that doesn't say where it
 * goes to say so: to the deployer, with its one error if it failed, or to
 * containers, with its targets. Run before anything else reads the store.
 */
// compat: delete once deployed infras run past 90784b2. Tags inbox and failed entries an older router kept untagged.
export const tagStored = async <T extends { to: string }>(store: JsonStore<T>) => {
  for (const name of await store.list()) {
    const entry = (await store.read(name)) as T | UntaggedEntry | undefined;
    if (!entry || entry.to) continue;
    const old = entry as UntaggedEntry;
    const [first] = old.targets;
    let tagged: unknown;
    if (first?.kind === "deployer") {
      const { host: _, ...event } = old.event;
      tagged = { to: "deployer", event, ...(first.error !== undefined && { error: first.error }) };
    } else {
      const targets = old.targets.map(({ kind: _, ...target }) => target);
      tagged = { to: "containers", event: old.event, targets, ...(old.told && { told: true }) };
    }
    await store.write(name, tagged as T);
  }
};

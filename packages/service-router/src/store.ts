import { repoName, type Stores } from "@achq/core";
import { channelEvent, deployerEvent, RouterRepoConfig } from "@achq/core/protocol";
import { collection, type Migration, renamed } from "@achq/utils/store";
import { z } from "zod";

// What the router keeps: stored schemas, so loose, as another version of the router may have written them.

/**
 * Where a channel event goes. `workspace` is the container's workspace the thread is worked in: the one that claimed it, or the first that matches it now. The container works it there.
 * `commit` is the one whose config the router holds, so the container runs the same config.
 */
export const ContainerTarget = z.looseObject({ repo: z.string(), container: z.string(), url: z.string(), workspace: z.string(), commit: z.string() });
export type ContainerTarget = z.infer<typeof ContainerTarget>;

/** Per thread key, per container: the workspace that claimed it. The router is the only one that decides and records claims. */
export const Claims = z.record(z.string(), z.record(z.string(), z.string()));
export type Claims = z.infer<typeof Claims>;

/** A repo event goes to the deployer, a channel event to the containers it targets. `told`: the thread has been told its delivery failed, so a failed replay doesn't tell it again. */
export const InboxEntry = z.discriminatedUnion("to", [
  z.looseObject({ to: z.literal("deployer"), event: deployerEvent }),
  z.looseObject({ to: z.literal("containers"), event: channelEvent, targets: z.array(ContainerTarget), told: z.boolean().optional() }),
]);
export type InboxEntry = z.infer<typeof InboxEntry>;

/** An entry the deployer, or some of its containers, never answered, and why: for containers, only the ones that didn't. */
export const FailedEntry = z.discriminatedUnion("to", [
  z.looseObject({ to: z.literal("deployer"), event: deployerEvent, error: z.string() }),
  z.looseObject({ to: z.literal("containers"), event: channelEvent, targets: z.array(ContainerTarget.extend({ error: z.string() })), told: z.boolean().optional() }),
]);
export type FailedEntry = z.infer<typeof FailedEntry>;

/** An inbox or failed entry as routers kept them before they said where they go: each target said what it was, a deployer event had a `host`, and a failed target its error. */
const UntaggedEntry = z.looseObject({
  to: z.undefined().optional(),
  event: z.record(z.string(), z.unknown()),
  targets: z.array(z.looseObject({ kind: z.enum(["deployer", "container"]), error: z.string().optional() })),
  told: z.boolean().optional(),
});

/**
 * Rewrites each inbox or failed entry that doesn't say where it goes to say
 * so: to the deployer, with its one error if it failed, or to containers, with
 * its targets.
 */
// compat: delete once deployed infras run past 90784b2. Tags inbox and failed entries an older router kept untagged.
const tagged: Migration<unknown> = async (raw) => {
  for (const name of await raw.list()) {
    const old = UntaggedEntry.safeParse(await raw.read(name));
    if (!old.success) continue;
    const { event, targets, told } = old.data;
    const [first] = targets;
    if (first?.kind === "deployer") {
      const { host: _, ...rest } = event;
      await raw.write(name, { to: "deployer", event: rest, ...(first.error !== undefined && { error: first.error }) });
    } else {
      await raw.write(name, { to: "containers", event, targets: targets.map(({ kind: _, ...target }) => target), ...(told && { told: true }) });
    }
  }
};

/** In its container provider's store, each by `repoName.key` or delivery ID, migrated. Only the router's config and claims are read whole, on start. */
export const createStore = async (stores: Stores, log?: (line: string) => void) => ({
  // compat: delete once deployed infras run past cb7a2f1. Moves what stores kept under file names (`owner__name`) to its key.
  repos: await collection(stores, "repos", RouterRepoConfig, { log, migrate: [renamed((_name, config) => repoName.key(config.repo))] }),
  // compat: delete once deployed infras run past cb7a2f1. Moves claims kept under file names (`owner__name`) to their repo's key.
  claims: await collection(stores, "claims", Claims, { log, migrate: [renamed((name) => (name.includes("/") ? name : name.replace("__", "/")))] }),
  /** Accepted deliveries some target hasn't answered yet, by delivery ID. */
  inbox: await collection(stores, "inbox", InboxEntry, { log, migrate: [tagged] }),
  /** Deliveries some target never answered, by delivery ID. */
  failed: await collection(stores, "failed", FailedEntry, { log, migrate: [tagged] }),
});

export type RouterStore = Awaited<ReturnType<typeof createStore>>;

import type { Stores } from "@achq/core";
import { channelEvent, deployerEvent, RouterRepoConfig } from "@achq/core/protocol";
import { collection } from "@achq/utils/store";
import * as v from "valibot";

// What the router keeps: stored schemas, so loose, as another version of the router may have written them.

/**
 * Where a channel event goes. `workspace` is the container's workspace the thread is worked in: the one that claimed it, or the first that matches it now. The container works it there.
 * `commit` is the one whose config the router holds, so the container runs the same config.
 */
export const ContainerTarget = v.looseObject({ repo: v.string(), container: v.string(), url: v.string(), workspace: v.string(), commit: v.string() });
export type ContainerTarget = v.InferOutput<typeof ContainerTarget>;

/** Per thread key, per container: the workspace that claimed it. The router is the only one that decides and records claims. */
export const Claims = v.record(v.string(), v.record(v.string(), v.string()));
export type Claims = v.InferOutput<typeof Claims>;

/** A repo event goes to the deployer, a channel event to the containers it targets. `told`: the thread has been told its delivery failed, so a failed replay doesn't tell it again. */
export const InboxEntry = v.variant("to", [
  v.looseObject({ to: v.literal("deployer"), event: deployerEvent }),
  v.looseObject({ to: v.literal("containers"), event: channelEvent, targets: v.array(ContainerTarget), told: v.optional(v.boolean()) }),
]);
export type InboxEntry = v.InferOutput<typeof InboxEntry>;

/** An entry the deployer, or some of its containers, never answered, and why: for containers, only the ones that didn't. */
export const FailedEntry = v.variant("to", [
  v.looseObject({ to: v.literal("deployer"), event: deployerEvent, error: v.string() }),
  v.looseObject({ to: v.literal("containers"), event: channelEvent, targets: v.array(v.looseObject({ ...ContainerTarget.entries, error: v.string() })), told: v.optional(v.boolean()) }),
]);
export type FailedEntry = v.InferOutput<typeof FailedEntry>;

/** In its container provider's store, each by `repoName.key` or delivery ID. Only the router's config and claims are read whole, on start. */
export const createStore = async (stores: Stores, log?: (line: string) => void) => ({
  repos: await collection(stores, "repos", RouterRepoConfig, { log }),
  claims: await collection(stores, "claims", Claims, { log }),
  /** Accepted deliveries some target hasn't answered yet, by delivery ID. */
  inbox: await collection(stores, "inbox", InboxEntry, { log }),
  /** Deliveries some target never answered, by delivery ID. */
  failed: await collection(stores, "failed", FailedEntry, { log }),
});

export type RouterStore = Awaited<ReturnType<typeof createStore>>;

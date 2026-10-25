import type { Stores } from "@achq/core";
import { channelEvent, deployerEvent, RouterRepoConfig } from "@achq/core/protocol";
import { collection } from "@achq/utils/store";
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

/** In its container provider's store, each by `repoName.key` or delivery ID. Only the router's config and claims are read whole, on start. */
export const createStore = async (stores: Stores, log?: (line: string) => void) => ({
  repos: await collection(stores, "repos", RouterRepoConfig, { log }),
  claims: await collection(stores, "claims", Claims, { log }),
  /** Accepted deliveries some target hasn't answered yet, by delivery ID. */
  inbox: await collection(stores, "inbox", InboxEntry, { log, }),
  /** Deliveries some target never answered, by delivery ID. */
  failed: await collection(stores, "failed", FailedEntry, { log, }),
});

export type RouterStore = Awaited<ReturnType<typeof createStore>>;

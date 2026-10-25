import { repoName, type Stores } from "@achq/core";
import { RepoManifest } from "@achq/core/manifest";
import { DeployRecord, SyncResult } from "@achq/core/protocol";
import { async } from "@achq/utils/async";
import { Job, jobs } from "@achq/utils/jobs";
import { collection, renamed } from "@achq/utils/store";
import { z } from "zod";

/** How many syncs' outcomes are kept for `GET /sync/<id>`: the newest started. */
const KEPT_SYNCS = 10;

/** How often a running sync says so: one that's stopped for a few beats reads as interrupted. */
const SYNC_HEARTBEAT_MS = 5_000;

/** How many delivery IDs are remembered as handled: the newest. */
const MAX_DELIVERIES = 5000;

/** The one value in the `deliveries` collection: the IDs handled. */
const HANDLED = "handled";

// What the deployer keeps: stored schemas, so loose, as another version of the deployer may have written them.

/** What a container was last deployed from: a change to either means a rebuild. */
export const ImageRecord = z.looseObject({ dockerfile: z.string(), blob: z.string() });
export type ImageRecord = z.infer<typeof ImageRecord>;

/**
 * The last deploy that succeeded, kept across later failures and uninstalls.
 * `given` is a hash of what the deployer gave its containers, so a change to it
 * deploys again, as a change to the config does.
 */
export const DeployedSnapshot = z.looseObject({ tree: z.string(), manifest: RepoManifest, images: z.record(z.string(), ImageRecord), given: z.string().optional() });
export type DeployedSnapshot = z.infer<typeof DeployedSnapshot>;

export const StoredRecord = DeployRecord.extend({ deployed: DeployedSnapshot.optional() });
export type StoredRecord = z.infer<typeof StoredRecord>;

/** The record without what only the deployer reads. */
export const wireRecord = ({ deployed: _deployed, ...record }: StoredRecord): DeployRecord => record;

/** In its container provider's store, migrated: a record per repo, by `repoName.key`, the deliveries it's handled, and its syncs, so a restart doesn't lose how one went. */
export const createStore = async (stores: Stores, log?: (line: string) => void) => {
  const records = await collection(stores, "records", StoredRecord, {
    log,
    // compat: delete once deployed infras run past cb7a2f1. Moves what stores kept under file names (`owner__name`) to its key.
    migrate: [renamed((_name, record) => repoName.key(record.repo))],
  });
  const handled = await collection(stores, "deliveries", z.array(z.string()), { log });
  let deliveries: string[] | undefined;
  const loadDeliveries = async () => (deliveries ??= (await handled.read(HANDLED)) ?? []);
  // One list, shared by every caller, so writes go in order: an older list can't land after a newer one.
  const inOrder = async.serial();
  const syncs = jobs(await collection(stores, "syncs", Job(SyncResult), { log }), { keep: KEPT_SYNCS, heartbeatMs: SYNC_HEARTBEAT_MS, log: log && ((line) => log(`sync ${line}`)) });

  return {
    syncs,
    get: (repo: string) => records.read(repoName.key(repo)),
    put: (record: StoredRecord) => records.write(repoName.key(record.repo), record),
    /** Every record, in name order. */
    all: () => records.all(),
    handled: async (delivery: string) => (await loadDeliveries()).includes(delivery),
    async markHandled(delivery: string) {
      const list = await loadDeliveries();
      if (list.includes(delivery)) return;
      list.push(delivery);
      if (list.length > MAX_DELIVERIES) list.splice(0, list.length - MAX_DELIVERIES);
      await inOrder(() => handled.write(HANDLED, list));
    },
  };
};

export type Store = Awaited<ReturnType<typeof createStore>>;

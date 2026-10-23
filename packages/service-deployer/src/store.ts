import { type DeployRecord, type RepoManifest, repoName, type Stores } from "@achq/core";
import { async } from "@achq/utils/async";
import { disk } from "@achq/utils/disk";

/** How many delivery IDs are remembered as handled: the newest. */
const MAX_DELIVERIES = 5000;

/** The one value in the `deliveries` collection: the IDs handled. */
const HANDLED = "handled";

/** A name can't start with `.` or be empty: it may be a file's. */
const UNSAFE_START = /^\.|^$/;

/** What a container was last deployed from: a change to either means a rebuild. */
export type ImageRecord = { dockerfile: string; blob: string };

/**
 * The last deploy that succeeded, kept across later failures and uninstalls.
 * `given` is a hash of what the deployer gave its containers, so a change to it
 * deploys again, as a change to the config does.
 */
export type DeployedSnapshot = { tree: string; manifest: RepoManifest; images: Record<string, ImageRecord>; given?: string };

export type StoredRecord = DeployRecord & { deployed?: DeployedSnapshot };

/** The record without what only the deployer reads. */
export const wireRecord = ({ deployed: _deployed, ...record }: StoredRecord): DeployRecord => record;

/** A failed deploy of a name that's no repo's is recorded too, so this takes any string. */
export const recordName = (repo: string) => disk.safeFileName(repoName.key(repo).replace("/", "__")).replace(UNSAFE_START, "_");

/** In its container provider's store: a record per repo, and the deliveries it's handled. */
export const createStore = (stores: Stores) => {
  const records = stores<StoredRecord>("records");
  const handled = stores<string[]>("deliveries");
  let deliveries: string[] | undefined;
  const loadDeliveries = async () => (deliveries ??= (await handled.read(HANDLED)) ?? []);
  // One list, shared by every caller, so writes go in order: an older list can't land after a newer one.
  const inOrder = async.serial();

  return {
    get: (repo: string) => records.read(recordName(repo)),
    put: (record: StoredRecord) => records.write(recordName(record.repo), record),
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

export type Store = ReturnType<typeof createStore>;

import { type DeployRecord, renameStored, repoName, type Stores } from "@achq/core";
import type { RepoManifest } from "@achq/core/manifest";
import { async } from "@achq/utils/async";

/** How many delivery IDs are remembered as handled: the newest. */
const MAX_DELIVERIES = 5000;

/** The one value in the `deliveries` collection: the IDs handled. */
const HANDLED = "handled";

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

/** In its container provider's store: a record per repo, by `repoName.key`, and the deliveries it's handled. */
export const createStore = (stores: Stores) => {
  const records = stores<StoredRecord>("records");
  const handled = stores<string[]>("deliveries");
  let deliveries: string[] | undefined;
  const loadDeliveries = async () => (deliveries ??= (await handled.read(HANDLED)) ?? []);
  // One list, shared by every caller, so writes go in order: an older list can't land after a newer one.
  const inOrder = async.serial();

  return {
    /** Once only, before the first use; deleted with renameStored. */
    migrate: () => renameStored(records, (_name, record) => repoName.key(record.repo)),
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

export type Store = ReturnType<typeof createStore>;

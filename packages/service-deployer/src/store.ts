import { join } from "node:path";
import { type DeployRecord, type RepoManifest, repoName } from "@achq/core";
import { async } from "@achq/utils/async";
import { disk, JsonDirStore } from "@achq/utils/disk";

/** How many delivery IDs are remembered as handled: the newest. */
const MAX_DELIVERIES = 5000;

/** The deployer's files are its own: they hold every repo's deploy state. */
const PRIVATE_FILE_MODE = 0o600;

/** A file name can't start with `.` or be empty. */
const UNSAFE_START = /^\.|^$/;

/** What a container was last deployed from: a change to either means a rebuild. */
export type ImageRecord = { dockerfile: string; blob: string };

/** The last deploy that succeeded, kept across later failures and uninstalls. */
export type DeployedSnapshot = { tree: string; manifest: RepoManifest; images: Record<string, ImageRecord> };

export type StoredRecord = DeployRecord & { deployed?: DeployedSnapshot };

/** The record without what only the deployer reads. */
export const wireRecord = ({ deployed: _deployed, ...record }: StoredRecord): DeployRecord => record;

/** A failed deploy of a name that's no repo's is recorded too, so this takes any string. */
export const recordName = (repo: string) => disk.safeFileName(repoName.key(repo).replace("/", "__")).replace(UNSAFE_START, "_");

export const createStore = (dataDir: string) => {
  const records = new JsonDirStore<StoredRecord>(join(dataDir, "records"), { pretty: true, mode: PRIVATE_FILE_MODE });
  const deliveriesFile = join(dataDir, "deliveries.json");
  let deliveries: string[] | undefined;
  const loadDeliveries = async () => (deliveries ??= (await disk.readJson<string[]>(deliveriesFile)) ?? []);
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
      await inOrder(() => disk.writeJson(deliveriesFile, list, { mode: PRIVATE_FILE_MODE }));
    },
  };
};

export type Store = ReturnType<typeof createStore>;

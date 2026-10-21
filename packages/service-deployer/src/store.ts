import { join } from "node:path";
import { type DeployRecord, type RepoManifest, repoName } from "@achq/core";
import { disk, JsonDirStore } from "@achq/utils/disk";
import { async } from "@achq/utils/async";
import { MAX_DELIVERIES, PRIVATE_FILE_MODE } from "./constants.ts";

/** What a container was last deployed from: a change to either means a rebuild. */
export type ImageRecord = { dockerfile: string; blob: string };

/** The last deploy that succeeded, kept across later failures and uninstalls. */
export type DeployedSnapshot = { tree: string; manifest: RepoManifest; images: Record<string, ImageRecord> };

export type StoredRecord = DeployRecord & { deployed?: DeployedSnapshot };

/** The record without what only the deployer reads. */
export const wireRecord = ({ deployed: _deployed, ...record }: StoredRecord): DeployRecord => record;


/** A file name can't start with `.` or be empty. */
const UNSAFE_START = /^\.|^$/;

/** A failed deploy of a name that's no repo's is recorded too, so this takes any string. */
export const recordName = (repo: string) => disk.safeFileName(repoName.key(repo).replace("/", "__")).replace(UNSAFE_START, "_");

const dropOldest = (list: string[]) => {
  if (list.length > MAX_DELIVERIES) list.splice(0, list.length - MAX_DELIVERIES);
};

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
      dropOldest(list);
      await inOrder(() => disk.writeJson(deliveriesFile, list, { mode: PRIVATE_FILE_MODE }));
    },
  };
};

export type Store = ReturnType<typeof createStore>;

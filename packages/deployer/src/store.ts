// The deployer's state on its volume: a record per repo, and the delivery IDs
// it has handled. Every write goes to a temp file and is renamed into place.
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeployRecord } from "@achq/core";
import type { RepoPlan } from "@achq/core";

/** What a container was last deployed from: a change to either means a rebuild. */
export type ImageRecord = { dockerfile: string; blob: string };

/** The last deploy that succeeded, kept across later failures and uninstalls. */
export type DeployedSnapshot = { commit: string; tree: string; plan: RepoPlan; images: Record<string, ImageRecord> };

export type StoredRecord = DeployRecord & { deployed?: DeployedSnapshot };

const MAX_DELIVERIES = 5000;

export const atomicWrite = async (path: string, contents: string) => {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, path);
};

export const recordFile = (repo: string) => `${repo.toLowerCase().replace("/", "__").replace(/[^a-z0-9_.-]/g, "_")}.json`;

export const createStore = (dataDir: string) => {
  const recordsDir = join(dataDir, "records");
  const deliveriesFile = join(dataDir, "deliveries.json");
  let deliveries: string[] | undefined;
  const ready = mkdir(recordsDir, { recursive: true });

  const loadDeliveries = async () => {
    if (deliveries) return deliveries;
    const file = Bun.file(deliveriesFile);
    deliveries = (await file.exists()) ? ((await file.json()) as string[]) : [];
    return deliveries;
  };

  return {
    async get(repo: string): Promise<StoredRecord | undefined> {
      await ready;
      const file = Bun.file(join(recordsDir, recordFile(repo)));
      return (await file.exists()) ? ((await file.json()) as StoredRecord) : undefined;
    },
    async put(record: StoredRecord) {
      await ready;
      await atomicWrite(join(recordsDir, recordFile(record.repo)), JSON.stringify(record, null, 2));
    },
    async all(): Promise<StoredRecord[]> {
      await ready;
      const names = (await readdir(recordsDir)).filter((n) => n.endsWith(".json")).sort();
      return Promise.all(names.map(async (n) => (await Bun.file(join(recordsDir, n)).json()) as StoredRecord));
    },
    async handled(delivery: string) {
      return (await loadDeliveries()).includes(delivery);
    },
    async markHandled(delivery: string) {
      await ready;
      const list = await loadDeliveries();
      if (list.includes(delivery)) return;
      list.push(delivery);
      if (list.length > MAX_DELIVERIES) list.splice(0, list.length - MAX_DELIVERIES);
      await atomicWrite(deliveriesFile, JSON.stringify(list));
    },
  };
};

export type Store = ReturnType<typeof createStore>;

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DeployRecord, RepoManifest } from "@achq/core";
import { atomicWrite } from "./atomic-write.ts";
import { MAX_DELIVERIES } from "./constants.ts";

/** What a container was last deployed from: a change to either means a rebuild. */
export type ImageRecord = { dockerfile: string; blob: string };

/** The last deploy that succeeded, kept across later failures and uninstalls. */
export type DeployedSnapshot = { tree: string; manifest: RepoManifest; images: Record<string, ImageRecord> };

export type StoredRecord = DeployRecord & { deployed?: DeployedSnapshot };

/** The record without what only the deployer reads. */
export const wireRecord = ({ deployed: _deployed, ...record }: StoredRecord): DeployRecord => record;

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

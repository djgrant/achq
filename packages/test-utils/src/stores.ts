import { join } from "node:path";
import type { Stores } from "@achq/core";
import { JsonDirStore } from "@achq/utils/disk";

/** A container provider's store as files under `dir`, as Railway's is under DATA_DIR. */
export const dirStores =
  (dir: string): Stores =>
  (collection) =>
    new JsonDirStore(join(dir, collection));

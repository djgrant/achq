import * as path from "node:path";
import { disk } from "@achq/utils/disk";

/** Records the delivery in `dir`; false if it was already handled. Persisted, so it holds across restarts. */
export const firstDelivery = (dir: string, delivery: string) => disk.createExclusive(path.join(dir, disk.safeFileName(delivery)));

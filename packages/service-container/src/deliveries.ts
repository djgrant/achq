import * as path from "node:path";
import { createExclusive, safeFileName } from "@achq/utils/fs";

/** Records the delivery in `dir`; false if it was already handled. Persisted, so it holds across restarts. */
export const firstDelivery = (dir: string, delivery: string) => createExclusive(path.join(dir, safeFileName(delivery)));

import * as fs from "node:fs";
import * as path from "node:path";

/** Records the delivery in `dir`; false if it was already handled. Persisted, so it holds across restarts. */
export const firstDelivery = (dir: string, delivery: string) => {
  try {
    fs.writeFileSync(path.join(dir, delivery.replace(/[^A-Za-z0-9._-]/g, "_")), "", { flag: "wx" });
    return true;
  } catch (e: any) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
};

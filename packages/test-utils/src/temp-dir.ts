import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A temporary directory, added to `dirs` for the test to remove. */
export const tempDir = (dirs: string[]) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "achq-container-")));
  dirs.push(dir);
  return dir;
};

// A directory read whole, for shipping it somewhere as data.
import * as fs from "node:fs";
import * as path from "node:path";

/** Every file under `dir`, by path relative to it, as text. Directories named in `skip` aren't entered. */
export const readTree = (dir: string, { skip = [] }: { skip?: string[] } = {}): Record<string, string> => {
  const files: Record<string, string> = {};
  const walk = (sub: string) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory() && !skip.includes(entry.name)) walk(rel);
      if (entry.isFile()) files[rel] = fs.readFileSync(path.join(dir, rel), "utf8");
    }
  };
  walk("");
  return files;
};

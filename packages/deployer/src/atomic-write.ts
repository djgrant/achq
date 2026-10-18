import { rename, writeFile } from "node:fs/promises";

/** Writes to a temp file and renames it into place, so a crash never leaves half a file. */
export const atomicWrite = async (path: string, contents: string) => {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, path);
};

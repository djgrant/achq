import * as path from "node:path";

/** A path in `.achq/`, refusing anything that leaves it. */
export const inRoot = (root: string, relative: string) => {
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) throw new Error(`${relative} is outside .achq/`);
  return file;
};

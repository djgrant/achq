import { resolveWithin } from "@achq/utils/fs";

/** A path in `.achq/`, refusing anything that leaves it. */
export const inRoot = (root: string, relative: string) => {
  const file = resolveWithin(root, relative);
  if (!file) throw new Error(`${relative} is outside .achq/`);
  return file;
};

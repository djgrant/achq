// Paths built from names and relative paths that come from outside: a thread
// id, a delivery id, a path written in a repo's config.
import * as path from "node:path";

/** Names that are safe as one path segment: no separators, and not `.` or `..`. */
const SAFE_FILE_NAME = /^[\w-][\w.-]*$/;
const UNSAFE_CHAR = /[^A-Za-z0-9._-]/g;

/** Whether `name` can be used as a file name as it is. */
export const isSafeFileName = (name: string): boolean => SAFE_FILE_NAME.test(name);

/** `name` with every character that's unsafe in a file name replaced by `_`. */
export const safeFileName = (name: string): string => name.replace(UNSAFE_CHAR, "_");

/** Whether `file` is `root` or inside it. Both must be absolute and normalised. */
export const isWithin = (root: string, file: string): boolean => file === root || file.startsWith(root + path.sep);

/** `relative` resolved against `root`, or undefined if it leads outside `root`. */
export const resolveWithin = (root: string, relative: string): string | undefined => {
  const file = path.resolve(root, relative);
  return isWithin(path.resolve(root), file) ? file : undefined;
};

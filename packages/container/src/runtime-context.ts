import * as fs from "node:fs";
import type { RuntimeContext } from "@achq/core";
import { inRoot } from "./config/path.ts";
import { resolveFiles } from "./files.ts";

export const runtimeContext = (root: string, rest: Omit<RuntimeContext, "readFile" | "resolveFiles">): RuntimeContext => ({
  readFile: (relative) => fs.readFileSync(inRoot(root, relative), "utf8"),
  resolveFiles: (files) => resolveFiles(files, root),
  ...rest,
});

import * as fs from "node:fs";
import type { Claude } from "@achq/claude";
import { claudeRuntime } from "@achq/claude/runtime";
import type { RuntimeContext, RuntimeFactory } from "@achq/core";
import { inRoot, resolveFiles } from "./files.ts";

/** Agent kinds → their runtimes. */
export const defaultRuntimes: Record<string, RuntimeFactory> = {
  claude: (agent, ctx) => claudeRuntime(agent as Claude, ctx),
};

export const runtimeContext = (root: string, rest: Omit<RuntimeContext, "readFile" | "resolveFiles">): RuntimeContext => ({
  readFile: (relative) => fs.readFileSync(inRoot(root, relative), "utf8"),
  resolveFiles: (files) => resolveFiles(files, root),
  ...rest,
});

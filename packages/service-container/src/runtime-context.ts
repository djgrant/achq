import * as fs from "node:fs";
import type { RepoManifest, RuntimeContext } from "@achq/core";
import type { LoadedConfig } from "./config/loader.ts";
import { inRoot } from "./config/path.ts";
import { withoutPrivate } from "./env.ts";
import { resolveFiles } from "./files.ts";
import { runnerPrompt } from "./runner-prompt.ts";

type Container = RepoManifest["containers"][number];

export const runtimeContext = (root: string, rest: Omit<RuntimeContext, "readFile" | "resolveFiles">): RuntimeContext => ({
  readFile: (relative) => fs.readFileSync(inRoot(root, relative), "utf8"),
  resolveFiles: (files) => resolveFiles(files, root),
  ...rest,
});

/** What runtimes get in this container: its HOME, achq's prompt, `container`'s startup files, and `env` without private variables. */
export const containerContext = (config: LoadedConfig, home: string, env: Record<string, string | undefined>, container: Container | undefined): RuntimeContext =>
  runtimeContext(config.root, {
    home,
    runnerPrompt: runnerPrompt(),
    containerFiles: resolveFiles(container?.files, config.root),
    env: withoutPrivate(env),
  });

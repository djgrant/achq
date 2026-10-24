import * as fs from "node:fs";
import type { RepoManifest, RuntimeContext } from "@achq/core";
import { collections } from "@achq/utils/collections";
import { disk } from "@achq/utils/disk";
import type { Vars } from "@achq/utils/env";
import { AGENT_PROVIDERS } from "achq/registry";
import { withoutPrivate } from "./agent-env.ts";
import { inRoot, type LoadedConfig } from "./config.ts";
import { runnerPrompt } from "./prompt.ts";

type Container = RepoManifest["containers"][number];

export const defaultRuntimes = Object.fromEntries(AGENT_PROVIDERS.map((a) => [a.id, a.runtime]));

/**
 * Startup files' contents: a string value is a file in `.achq/`, anything else
 * is written as JSON. Keys are the target paths, as declared.
 */
export const resolveFiles = (files: Record<string, unknown> | undefined, root: string) => {
  const contentOf = (value: unknown) => (typeof value === "string" ? fs.readFileSync(inRoot(root, value), "utf8") : `${JSON.stringify(value, null, 2)}\n`);
  return collections.mapValues(collections.sortKeys(files ?? {}), contentOf);
};

export const writeFiles = (resolved: Record<string, string>, home: string) => {
  for (const [key, content] of Object.entries(resolved)) disk.writeEnsured(disk.underHome(key, home), content);
};

export const runtimeContext = (root: string, rest: Omit<RuntimeContext, "readFile" | "resolveFiles">): RuntimeContext => ({
  readFile: (relative) => fs.readFileSync(inRoot(root, relative), "utf8"),
  resolveFiles: (files) => resolveFiles(files, root),
  ...rest,
});

/** What runtimes get in this container: its HOME, achq's prompt, `container`'s startup files, and `env` without private variables. */
export const containerContext = (config: LoadedConfig, home: string, env: Vars, container: Container | undefined) =>
  runtimeContext(config.root, {
    home,
    runnerPrompt: runnerPrompt(),
    containerFiles: resolveFiles(container?.files, config.root),
    env: withoutPrivate(env),
  });

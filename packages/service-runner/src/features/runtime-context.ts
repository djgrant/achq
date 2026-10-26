import * as fs from "node:fs";
import type { AgentProvider, RuntimeContext, RuntimeFactory } from "@achq/core";
import type { RepoManifest } from "@achq/core/manifest";
import { collections } from "@achq/utils/collections";
import { disk } from "@achq/utils/disk";
import type { Vars } from "@achq/utils/env";
import { withoutPrivate } from "./agent-env.ts";
import { inRoot, type LoadedConfig } from "./config.ts";
import { runnerPrompt } from "./prompt.ts";

type Container = RepoManifest["containers"][number];

/** Each agent provider's runtime, by the id agents name it by. */
export const runtimesOf = (agents: AgentProvider[]): Record<string, RuntimeFactory> => Object.fromEntries(agents.map((a) => [a.id, a.runtime]));

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

export const runtimeContext = (root: string, rest: Omit<RuntimeContext, "readFile" | "resolveFiles">) => ({
  readFile: (relative) => fs.readFileSync(inRoot(root, relative), "utf8"),
  resolveFiles: (files) => resolveFiles(files, root),
  ...rest,
}) satisfies RuntimeContext;

/** What runtimes get in this container: its HOME, achq's prompt, `container`'s startup files, and `env` without `privateEnv`. */
export const containerContext = (config: LoadedConfig, home: string, env: Vars, privateEnv: string[], container: Container | undefined) =>
  runtimeContext(config.root, {
    home,
    runnerPrompt: runnerPrompt(),
    containerFiles: resolveFiles(container?.files, config.root),
    env: withoutPrivate(env, privateEnv),
  });

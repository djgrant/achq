import * as fs from "node:fs";
import type { AgentProvider, DriverContext, DriverFactory } from "@achq/core";
import type { RepoManifest } from "@achq/core/manifest";
import { collections } from "@achq/utils/collections";
import { disk } from "@achq/utils/disk";
import type { Vars } from "@achq/utils/env";
import { withoutPrivate } from "./agent-env.ts";
import { inRoot, type LoadedConfig } from "./config.ts";
import { runnerPrompt } from "./prompt.ts";

type Container = RepoManifest["containers"][number];

/** Each agent provider's driver factory, by the id of the runtime agents name it by. */
export const driversOf = (agents: AgentProvider[]): Record<string, DriverFactory> => Object.fromEntries(agents.map((a) => [a.id, a.driver]));

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

export const driverContext = (root: string, rest: Omit<DriverContext, "readFile" | "resolveFiles">) => ({
  readFile: (relative) => fs.readFileSync(inRoot(root, relative), "utf8"),
  resolveFiles: (files) => resolveFiles(files, root),
  ...rest,
}) satisfies DriverContext;

/** What drivers get in this container: its HOME, achq's prompt, `container`'s startup files, and `env` without `privateEnv`. */
export const containerContext = (config: LoadedConfig, home: string, env: Vars, privateEnv: string[], container: Container | undefined) =>
  driverContext(config.root, {
    home,
    runnerPrompt: runnerPrompt(),
    containerFiles: resolveFiles(container?.files, config.root),
    env: withoutPrivate(env, privateEnv),
  });

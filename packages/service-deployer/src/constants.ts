import { CONFIG_MODULES } from "achq/registry";
import type { FileLimits } from "@achq/core";

export const DEFAULT_FILE_LIMITS: FileLimits = { maxFiles: 200, maxBytes: 1024 * 1024 };

export const MAX_DELIVERIES = 5000;

export const DEFAULT_DATA_DIR = "/data";

/** The deployer's files are its own: they hold every repo's deploy state. */
export const PRIVATE_FILE_MODE = 0o600;

export const CONFIG_DIR = ".achq";
export const CONFIG_ENTRY = "config.ts";

export const LOADERS = { ts: "ts", mts: "ts", tsx: "tsx", js: "js", mjs: "js", json: "json" } as const;

/** Where `.achq/`, achq's own modules and the entry module sit in the sandbox's module names. */
export const SANDBOX_ROOT = "/.achq";
export const SANDBOX_LIB = "/achq";
export const SANDBOX_ENTRY = "/entry.js";
/** What a config's bare imports resolve to: `achq` is the package's index, `achq/<x>` its `<x>` module. */
export const SANDBOX_IMPORTS: Record<string, string> = Object.fromEntries(
  CONFIG_MODULES.map((specifier) => [specifier, `${SANDBOX_LIB}/${specifier === "achq" ? "index" : specifier.slice("achq/".length)}.js`]),
);

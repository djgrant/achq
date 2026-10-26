import pkg from "../package.json" with { type: "json" };
import type { Plugin } from "./resources/resource.ts";

/** Core itself, which every process has: its resources' plugin, never installed apart from the process. */
export const PLUGIN: Plugin = { package: pkg.name, version: pkg.version };

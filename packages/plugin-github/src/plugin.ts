import type { Plugin } from "@achq/core";
import pkg from "../package.json" with { type: "json" };

/** This package, at the version installed where its resources are declared: the services and containers that need its providers install it. */
export const PLUGIN: Plugin = { package: pkg.name, version: pkg.version };

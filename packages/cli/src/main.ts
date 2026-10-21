import { runCli } from "@pokit/core";
import { createTerminalUI } from "@pokit/terminal";
import * as path from "node:path";
import { loadConfig, runUnderEnv, underEnv } from "./lib/config.ts";

const root = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const config = underEnv() ? undefined : await loadConfig();

if (config?.env) {
  process.exitCode = await runUnderEnv({ ...config, env: config.env }, [process.execPath, Bun.main, ...args]);
} else {
  const ui = createTerminalUI();
  process.exitCode = await runCli(args, {
    commandsDir: path.join(root, "src/commands"),
    projectRoot: root,
    appName: "achq",
    version: (await Bun.file(path.join(root, "package.json")).json()).version,
    reporterAdapter: ui.reporter,
    prompter: ui.prompter,
    navigator: ui.navigator,
  });
}

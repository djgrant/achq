import { runCli } from "@pokit/core";
import { createTerminalUI } from "@pokit/terminal";
import * as path from "node:path";
import { envFrom, loadConfig } from "./lib/config.ts";

const root = path.resolve(import.meta.dir, "..");
const config = await loadConfig();
if (config?.env) {
  const env = await envFrom({ ...config, env: config.env }).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
  Object.assign(process.env, env);
}

const ui = createTerminalUI();
process.exitCode = await runCli(process.argv.slice(2), {
  commandsDir: path.join(root, "src/commands"),
  projectRoot: root,
  appName: "achq",
  version: (await Bun.file(path.join(root, "package.json")).json()).version,
  reporterAdapter: ui.reporter,
  prompter: ui.prompter,
  navigator: ui.navigator,
});

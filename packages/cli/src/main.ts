import { runCli } from "@pokit/core";
import { createTerminalUI } from "@pokit/terminal";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
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

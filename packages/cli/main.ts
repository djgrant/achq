import { runCli } from "@pokit/core";
import { createTerminalUI } from "@pokit/terminal";
import * as path from "node:path";
import { commands } from "./commands.ts";
import { configEnv } from "./envs/config.ts";
import pkg from "./package.json" with { type: "json" };

const root = import.meta.dir;
const env = await (async () => configEnv.resolve([], {}))().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
Object.assign(process.env, env);

const ui = createTerminalUI();
process.exitCode = await runCli(process.argv.slice(2), {
  plugins: [commands],
  // pok also loads any ./commands under appDir, which would mount commands.ts's list twice: bin/ has none, in the checkout or published.
  appDir: path.join(root, "bin"),
  projectRoot: root,
  appName: "achq",
  version: pkg.version,
  reporterAdapter: ui.reporter,
  prompter: ui.prompter,
  navigator: ui.navigator,
});

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.ts";
import { resume } from "./resume.ts";
import { serve } from "./server.ts";

// github-agent               run the agent (the container's CMD)
// github-agent resume <n>    open issue <n>'s session interactively (over SSH)
const cfg = loadConfig();
process.env.HOME = cfg.paths.home;
for (const dir of [cfg.paths.home, cfg.paths.issues]) fs.mkdirSync(dir, { recursive: true });

// Claude's defaults for the agent's runs and your resumed sessions. Other settings in the file are kept.
const settings = path.join(cfg.paths.home, ".claude", "settings.json");
fs.mkdirSync(path.dirname(settings), { recursive: true });
fs.writeFileSync(settings, JSON.stringify({
  ...(fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, "utf8")) : {}),
  model: "claude-opus-5-5",
  attribution: { commit: "", pr: "" },
}, null, 2));

const [command, arg] = process.argv.slice(2);
if (command === "resume") process.exit(await resume(cfg.paths, Number(arg)));
else if (command) throw new Error(`Unknown command: ${command}`);
else await serve(cfg);

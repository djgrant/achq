import * as fs from "node:fs";
import { loadConfig } from "./config.ts";
import { resume } from "./resume.ts";
import { serve } from "./server.ts";

// github-agent               run the agent (the container's CMD)
// github-agent resume <n>    open issue <n>'s session interactively (over SSH)
const cfg = loadConfig();
process.env.HOME = cfg.paths.home;
for (const dir of [cfg.paths.home, cfg.paths.issues]) fs.mkdirSync(dir, { recursive: true });

const [command, arg] = process.argv.slice(2);
if (command === "resume") process.exit(await resume(cfg.paths, Number(arg)));
else if (command) throw new Error(`Unknown command: ${command}`);
else await serve(cfg);

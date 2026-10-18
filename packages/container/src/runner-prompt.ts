import * as fs from "node:fs";
import * as path from "node:path";
import { PROMPTS, RUNNER_PROMPT_FILE } from "./constants.ts";

/** achq's system prompt, which every agent gets before the repo's. */
export const runnerPrompt = () => fs.readFileSync(path.join(PROMPTS, RUNNER_PROMPT_FILE), "utf8");

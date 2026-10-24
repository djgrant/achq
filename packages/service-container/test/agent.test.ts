import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tempDir } from "@achq/test-utils/temp-dir";
import { createAgent } from "../src/agent.ts";
import { DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES } from "../src/constants.ts";
import { time } from "@achq/utils/time";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const agent = (vars: Record<string, string>) =>
  createAgent({
    ACHQ_REPO: "acme/widgets",
    ACHQ_CONTAINER: "dev",
    DATA_DIR: tempDir(dirs),
    ACHQ_REPO_URL: "https://example.com/acme/widgets.git",
    ACHQ_ROUTER_URL: "http://router",
    ACHQ_CONTAINER_SECRET: "secret",
    ...vars,
  }) as unknown as { slots: { max: number }; runTimeoutMs: number };

test("an empty ACHQ_MAX_RUNS or ACHQ_RUN_TIMEOUT_MINUTES is unset, so the defaults apply", () => {
  const runner = agent({ ACHQ_MAX_RUNS: "", ACHQ_RUN_TIMEOUT_MINUTES: "" });
  expect(runner.slots.max).toBe(DEFAULT_MAX_RUNS);
  expect(runner.runTimeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MINUTES * time.MINUTE_MS);
});

test("ACHQ_MAX_RUNS and ACHQ_RUN_TIMEOUT_MINUTES set the limits, and anything but a whole number above 0 is refused", () => {
  const runner = agent({ ACHQ_MAX_RUNS: "5", ACHQ_RUN_TIMEOUT_MINUTES: "10" });
  expect(runner.slots.max).toBe(5);
  expect(runner.runTimeoutMs).toBe(10 * time.MINUTE_MS);
  expect(() => agent({ ACHQ_MAX_RUNS: "0" })).toThrow('ACHQ_MAX_RUNS must be a whole number above 0, not "0".');
  expect(() => agent({ ACHQ_RUN_TIMEOUT_MINUTES: "soon" })).toThrow('ACHQ_RUN_TIMEOUT_MINUTES must be a whole number above 0, not "soon".');
});

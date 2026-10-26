import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTAINER_PLUGINS, linkWorkspace } from "@achq/test-utils/helpers/plugins";
import { tempDir } from "@achq/test-utils/helpers/temp-dir";
import { time } from "@achq/utils/time";
import { containerPlugins, DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES, runnerFromEnv } from "../src/from-env.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const runner = async (vars: Record<string, string>) =>
  (await runnerFromEnv({
    ACHQ_REPO: "acme/widgets",
    ACHQ_CONTAINER: "dev",
    DATA_DIR: tempDir(dirs),
    ACHQ_REPO_URL: "https://example.com/acme/widgets.git",
    ACHQ_ROUTER_URL: "http://router",
    ACHQ_CONTAINER_SECRET: "secret",
    ACHQ_PLUGINS: "[]",
    ...vars,
  })) as unknown as { slots: { max: number }; runTimeoutMs: number };

test("an empty ACHQ_MAX_RUNS or ACHQ_RUN_TIMEOUT_MINUTES is unset, so the defaults apply", async () => {
  const r = await runner({ ACHQ_MAX_RUNS: "", ACHQ_RUN_TIMEOUT_MINUTES: "" });
  expect(r.slots.max).toBe(DEFAULT_MAX_RUNS);
  expect(r.runTimeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MINUTES * time.MINUTE_MS);
});

test("ACHQ_MAX_RUNS and ACHQ_RUN_TIMEOUT_MINUTES set the limits, and anything but a whole number above 0 is refused", async () => {
  const r = await runner({ ACHQ_MAX_RUNS: "5", ACHQ_RUN_TIMEOUT_MINUTES: "10" });
  expect(r.slots.max).toBe(5);
  expect(r.runTimeoutMs).toBe(10 * time.MINUTE_MS);
  await expect(runner({ ACHQ_MAX_RUNS: "0" })).rejects.toThrow('ACHQ_MAX_RUNS must be a whole number above 0, not "0".');
  await expect(runner({ ACHQ_RUN_TIMEOUT_MINUTES: "soon" })).rejects.toThrow('ACHQ_RUN_TIMEOUT_MINUTES must be a whole number above 0, not "soon".');
});

test("the container installs the plugins ACHQ_PLUGINS names under its data dir, once, and loads their providers", async () => {
  const dataDir = tempDir(dirs);
  let installs = 0;
  const install = async (dir: string) => {
    installs++;
    await linkWorkspace(dir);
  };
  const vars = { ACHQ_PLUGINS: JSON.stringify(CONTAINER_PLUGINS), ACHQ_GITHUB_APPS: "{}" };
  const loaded = await containerPlugins(vars, dataDir, { install });
  expect(loaded.providers.channels.map((c) => c.id)).toEqual(["github"]);
  expect(Object.keys(loaded.runtimes)).toEqual(["claude"]);
  expect(loaded.privateEnv).toContain("ACHQ_GITHUB_APPS");
  // A config imports core as the runner's own copy, and each plugin from where it was installed.
  expect(Object.keys(loaded.modules)).toEqual(["@achq/core", "@achq/github", "@achq/claude"]);
  // Linked here, as installing them is: it resolves through the link to this checkout's package.
  expect(loaded.modules["@achq/github"]).toBe(path.join(import.meta.dir, "..", "..", "plugin-github", "src", "index.ts"));
  expect(loaded.modules["@achq/core"]).toBe(Bun.resolveSync("@achq/core", path.join(import.meta.dir, "..", "src")));
  // Core and utils are installed beside them at the runner's own version, as their peer.
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, "plugins", "package.json"), "utf8")).dependencies).toEqual({
    "@achq/core": "0.1.0",
    "@achq/utils": "0.1.0",
    "@achq/github": "0.1.0",
    "@achq/claude": "0.1.0",
  });

  await containerPlugins(vars, dataDir, { install });
  expect(installs).toBe(1);
  await expect(containerPlugins({ ACHQ_PLUGINS: JSON.stringify([{ package: "@achq/core" }]) }, dataDir, { install })).rejects.toThrow();
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectManifest, resetDeclarations, type Status } from "@achq/core";
import { loadRepoManifest } from "../src/lib/load/repo-config.ts";
import { registerModules } from "../src/lib/load/modules.ts";
import { waitForStatus } from "../src/lib/status/read.ts";

// A real .achq/ directory, as the design's example writes it, with a local import.
const CONFIG = `
import { Container, Workspace, Trigger } from "achq";
import * as claude from "achq/claude";
import * as github from "achq/github";
import { docsLabels } from "./lib/labels.ts";

const channel = github.Channel.get("notation-achq");
const code = new github.Policy("code", { channel, permissions: { contents: "write", issues: "write", pull_requests: "write" } });
const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });
new Workspace("docs", { container: dev, threads: channel.issues.where({ labels: docsLabels }), branch: "docs/{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: channel.issues, branch: "issue-{number}", base: "main" });
const coder = new claude.Agent("coder", { model: "claude-opus-5-5", effort: "high" });
new Trigger("mention", { event: channel.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });
`;

let repoDir: string;
beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "achq-install-"));
  fs.mkdirSync(path.join(repoDir, ".achq/lib"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".achq/config.ts"), CONFIG);
  fs.writeFileSync(path.join(repoDir, ".achq/lib/labels.ts"), `export const docsLabels = ["docs"];`);
  fs.writeFileSync(path.join(repoDir, ".achq/Dockerfile"), "FROM oven/bun:1\n");
});
afterAll(() => fs.rmSync(repoDir, { recursive: true, force: true }));

test("a real config evaluates the same in the sandbox as imported with Bun", async () => {
  const sandboxed = await loadRepoManifest(repoDir);
  registerModules();
  resetDeclarations();
  await import(path.join(repoDir, ".achq", "config.ts"));
  const imported = collectManifest();
  expect(imported).toEqual(sandboxed);
  expect(sandboxed.workspaces.map((w) => w.name)).toEqual(["docs", "issues"]);
  expect(sandboxed.workspaces[0].threads).toMatchObject({ channel: "github", source: "notation-achq" });
});

const status = (at: string): Status => ({ host: "github", repo: "notationlabs/yieldstar", state: "deployed", at, router: "https://achq-router.up.railway.app" });

test("polling the status stops at the first result newer than the install", async () => {
  const since = new Date("2026-10-17T10:00:00Z");
  const results = [undefined, "2026-10-17T09:00:00Z", "2026-10-17T10:02:00Z"];
  let polls = 0;
  let reads = 0;
  let current: Status | undefined;
  const read = async () => (reads++, current);
  const sleep = async () => {
    const at = results[Math.min(++polls, results.length - 1)];
    current = at ? status(at) : undefined;
  };
  const found = await waitForStatus(read, "notationlabs/yieldstar", since, { sleep, now: () => 0 });
  expect(found?.at).toBe("2026-10-17T10:02:00Z");
  expect(polls).toBe(2); // slept after nothing and after the older result
  expect(reads).toBe(3);
});

test("polling gives up at the timeout", async () => {
  let clock = 0;
  const found = await waitForStatus(async () => status("2026-10-17T09:00:00Z"), "notationlabs/yieldstar", new Date("2026-10-17T10:00:00Z"), {
    timeoutMs: 180_000,
    intervalMs: 5000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  expect(found).toBeUndefined();
  expect(clock).toBe(180_000);
});

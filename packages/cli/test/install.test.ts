import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectManifest, resetDeclarations, type Status } from "@achq/core";
import { type FixDeps, fixInBrowser, loadRepoManifest, waitForStatus } from "../src/lib/repo.ts";
import * as achq from "achq";
import * as claude from "achq/claude";
import * as github from "achq/github";

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

/** Lets Bun import a repo config from outside achq, as the sandbox does. */
const registerConfigModules = () =>
  Bun.plugin({
    name: "achq-config",
    setup(build) {
      for (const [specifier, exports] of Object.entries({ achq, "achq/claude": claude, "achq/github": github })) build.module(specifier, () => ({ exports: { ...exports }, loader: "object" }));
    },
  });

test("a real config evaluates the same in the sandbox as imported with Bun", async () => {
  const sandboxed = await loadRepoManifest(repoDir);
  registerConfigModules();
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
  const found = await waitForStatus(read, "notationlabs/yieldstar", since, { sleep });
  expect(found?.at).toBe("2026-10-17T10:02:00Z");
  expect(polls).toBe(2); // slept after nothing and after the older result
  expect(reads).toBe(3);
});

test("polling gives up at the timeout", async () => {
  let clock = 0;
  const found = await waitForStatus(async () => status("2026-10-17T09:00:00Z"), "notationlabs/yieldstar", new Date("2026-10-17T10:00:00Z"), {
    timeoutMs: 180_000,
    intervalMs: 5000,
    sleep: async (ms) => void (clock += ms),
  });
  expect(found).toBeUndefined();
  expect(clock).toBe(180_000);
});

describe("a deploy that failed with something only you can fix", () => {
  const action = { url: "https://github.com/apps/cloudflare-workers-and-pages/installations/new", what: "install cloudflare-workers-and-pages on notationlabs/yieldstar" };
  const failed = (at: string): Status => ({ ...status(at), state: "failed", error: "Workers Builds can't see notationlabs/yieldstar", action });

  /** ACHQ_STATUS as the deployer writes it: after each redeploy, the next of `outcomes`. */
  const world = (outcomes: Status[], interactive = true) => {
    let current: Status = failed("2026-10-17T10:01:00Z");
    let clock = Date.parse("2026-10-17T10:05:00Z");
    const did: string[] = [];
    const deps: FixDeps = {
      status: async () => current,
      interactive,
      open: async (url, what) => void did.push(`open ${url} to ${what}`),
      waitForYou: async () => void did.push("waited for you"),
      redeploy: async (router, repo) => {
        did.push(`redeploy ${repo} through ${router}`);
        current = outcomes.shift()!;
      },
      log: (line) => did.push(line),
      now: () => new Date(clock++),
      wait: { sleep: async () => {} },
    };
    return { start: current, deps, did };
  };

  test("opens it, waits for you, has the router deploy again, and waits for that result", async () => {
    const { start, deps, did } = world([status("2026-10-17T10:06:00Z")]);
    const found = await fixInBrowser("notationlabs/yieldstar", start, deps);
    expect(found?.state).toBe("deployed");
    expect(did).toEqual([
      "The deploy needs you to install cloudflare-workers-and-pages on notationlabs/yieldstar.",
      `open ${action.url} to ${action.what}`,
      "waited for you",
      "redeploy notationlabs/yieldstar through https://achq-router.up.railway.app",
      "Deploying again…",
    ]);
  });

  test("tries again while it still needs you, a few times at most", async () => {
    const { start, deps, did } = world([failed("2026-10-17T10:06:00Z"), failed("2026-10-17T10:07:00Z"), failed("2026-10-17T10:08:00Z"), status("2026-10-17T10:09:00Z")]);
    const found = await fixInBrowser("notationlabs/yieldstar", start, deps);
    expect(found?.state).toBe("failed");
    expect(did.filter((d) => d.startsWith("redeploy"))).toHaveLength(3);
  });

  test("without a terminal, says what to do and stops; any other result is left as it is", async () => {
    const { start, deps, did } = world([], false);
    expect(await fixInBrowser("notationlabs/yieldstar", start, deps)).toBe(start);
    expect(did).toEqual([`To fix it, ${action.what} at ${action.url}, then run \`achq repo install\` again.`]);

    const other = world([]);
    const plain = { ...status("2026-10-17T10:01:00Z"), state: "failed" as const, error: "broken" };
    expect(await fixInBrowser("notationlabs/yieldstar", plain, other.deps)).toBe(plain);
    expect(other.did).toEqual([]);
  });
});

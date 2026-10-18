import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitHubClient } from "@achq/github/api";
import { checkApp } from "../src/lib/install/app-check.ts";
import { configApp, configNeeds } from "../src/lib/install/config-app.ts";
import { installRepo, uninstallRepo } from "../src/lib/install/installation.ts";
import { loadRepoPlan } from "../src/lib/load/repo-config.ts";
import { waitForStatus } from "../src/lib/status/read.ts";

// A real .achq/ directory, as the design's example writes it, with a local import.
const CONFIG = `
import { Container, Workspace, Trigger, Claude } from "achq";
import * as github from "achq/github";
import { docsLabels } from "./lib/labels.ts";

const app = github.App.get("notation-achq");
const code = new github.RepoPolicy("code", { app, permissions: { contents: "write", issues: "write", pull_requests: "write" } });
const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });
new Workspace("docs", { container: dev, threads: app.issues.where({ labels: docsLabels }), branch: "docs/{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: app.issues, branch: "issue-{number}", base: "main" });
const coder = new Claude("coder", { model: "claude-opus-5-5", effort: "high" });
new Trigger("mention", { event: app.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });
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

test("the App slug comes from a real config, evaluated in the sandbox or imported with Bun", async () => {
  const sandboxed = await loadRepoPlan(repoDir);
  const imported = await loadRepoPlan(repoDir, { sandbox: false });
  expect(imported).toEqual(sandboxed);
  expect(configApp(sandboxed)).toBe("notation-achq");
  expect(configNeeds(sandboxed, "notation-achq")).toEqual({
    events: ["issue_comment", "push"],
    permissions: { metadata: "read", actions_variables: "write", issues: "write", contents: "write", pull_requests: "write" },
  });
});

test("a config naming two Apps, or none, is refused", async () => {
  const plan = await loadRepoPlan(repoDir, { sandbox: false });
  const other = { name: "x", policy: { provider: "github", app: "other-app", repo: null, permissions: {} } };
  expect(() => configApp({ ...plan, policies: [...plan.policies, other] })).toThrow("several Apps (notation-achq, other-app)");
  expect(() => configApp({ ...plan, policies: [], workspaces: [], triggers: [] })).toThrow("names no GitHub App");
});

// ── A fake GitHub, as your gh login sees it ──

type Fake = {
  app?: { events: string[]; permissions: Record<string, string> };
  installations: { id: number; app_slug: string; account: { login: string; type: string }; repository_selection: "all" | "selected"; repos: string[] }[];
  status?: { value: string };
  calls: string[];
};
let fake: Fake;
let server: ReturnType<typeof Bun.serve>;
let gh: GitHubClient;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = `${req.method} ${url.pathname}`;
      fake.calls.push(route);
      let m: RegExpMatchArray | null;
      if ((m = route.match(/^GET \/apps\/(.+)$/))) return fake.app ? Response.json({ slug: m[1], ...fake.app }) : new Response("Not Found", { status: 404 });
      if (route === "GET /user/installations") {
        return Response.json({ total_count: fake.installations.length, installations: fake.installations.map(({ repos, ...i }) => i) });
      }
      if ((m = route.match(/^GET \/user\/installations\/(\d+)\/repositories$/))) {
        const i = fake.installations.find((x) => x.id === Number(m![1]))!;
        return Response.json({ repositories: i.repos.map((full_name) => ({ full_name })) });
      }
      if ((m = route.match(/^GET \/repos\/([^/]+\/[^/]+)$/))) return Response.json({ id: 777, full_name: m[1] });
      if ((m = route.match(/^(PUT|DELETE) \/user\/installations\/(\d+)\/repositories\/777$/))) {
        const i = fake.installations.find((x) => x.id === Number(m![2]))!;
        i.repos = m[1] === "PUT" ? [...i.repos, "notationlabs/yieldstar"] : i.repos.filter((r) => r !== "notationlabs/yieldstar");
        return new Response(null, { status: 204 });
      }
      if (route === "GET /repos/notationlabs/yieldstar/actions/variables/ACHQ_STATUS") {
        return fake.status ? Response.json({ name: "ACHQ_STATUS", ...fake.status }) : new Response("Not Found", { status: 404 });
      }
      return new Response(`no route ${route}`, { status: 500 });
    },
  });
  gh = new GitHubClient("token t", `http://localhost:${server.port}`);
});
afterAll(() => server.stop(true));
beforeEach(() => {
  fake = { installations: [], calls: [] };
});

test("a private App's 404 skips the App comparison", async () => {
  const plan = await loadRepoPlan(repoDir, { sandbox: false });
  expect(await checkApp(gh, "notation-achq", plan)).toEqual({ private: true });
});

test("a public App is compared with what the config needs", async () => {
  const plan = await loadRepoPlan(repoDir, { sandbox: false });
  fake.app = { events: ["issues", "push"], permissions: { contents: "read", issues: "write", pull_requests: "write", metadata: "read", actions_variables: "write" } };
  expect(await checkApp(gh, "notation-achq", plan)).toEqual({ private: false, missing: ["the issue_comment event", "contents: write"] });
  fake.app = { events: ["issues", "issue_comment", "push"], permissions: { contents: "write", issues: "write", pull_requests: "admin", metadata: "read", actions_variables: "write" } };
  expect(await checkApp(gh, "notation-achq", plan)).toEqual({ private: false, missing: [] });
});

test("install adds the repo to the owner's installation, or says where to install", async () => {
  expect(await installRepo(gh, "notation-achq", "notationlabs/yieldstar")).toEqual({ kind: "open", url: "https://github.com/apps/notation-achq/installations/new" });

  fake.installations = [
    { id: 1, app_slug: "notation-achq", account: { login: "djgrant", type: "User" }, repository_selection: "selected", repos: [] },
    { id: 2, app_slug: "notation-achq", account: { login: "NotationLabs", type: "Organization" }, repository_selection: "selected", repos: ["notationlabs/other"] },
  ];
  expect(await installRepo(gh, "notation-achq", "notationlabs/yieldstar")).toEqual({ kind: "installed", installation: 2 });
  expect(fake.calls).toContain("PUT /user/installations/2/repositories/777");
  expect(await installRepo(gh, "notation-achq", "notationlabs/yieldstar")).toEqual({ kind: "already", installation: 2, all: false });

  await uninstallRepo(gh, "notation-achq", "notationlabs/yieldstar");
  expect(fake.installations[1].repos).toEqual(["notationlabs/other"]);

  fake.installations[1].repository_selection = "all";
  expect(await installRepo(gh, "notation-achq", "notationlabs/yieldstar")).toEqual({ kind: "already", installation: 2, all: true });
  await expect(uninstallRepo(gh, "notation-achq", "notationlabs/yieldstar")).rejects.toThrow("organizations/NotationLabs/settings/installations/2");
});

test("polling ACHQ_STATUS stops at the first result newer than the install", async () => {
  const since = new Date("2026-10-17T10:00:00Z");
  const results = [undefined, "2026-10-17T09:00:00Z", "2026-10-17T10:02:00Z"];
  let polls = 0;
  const sleep = async () => {
    const at = results[Math.min(++polls, results.length - 1)];
    fake.status = at ? { value: JSON.stringify({ repo: "notationlabs/yieldstar", source: "notation-achq", state: "deployed", at }) } : undefined;
  };
  const status = await waitForStatus(gh, "notationlabs/yieldstar", since, { sleep, now: () => 0 });
  expect(status?.at).toBe("2026-10-17T10:02:00Z");
  expect(polls).toBe(2); // slept after the 404 and after the older result
  expect(fake.calls.filter((c) => c.endsWith("ACHQ_STATUS"))).toHaveLength(3);
});

test("polling gives up at the timeout", async () => {
  fake.status = { value: JSON.stringify({ repo: "notationlabs/yieldstar", source: "notation-achq", state: "deployed", at: "2026-10-17T09:00:00Z" }) };
  let clock = 0;
  const status = await waitForStatus(gh, "notationlabs/yieldstar", new Date("2026-10-17T10:00:00Z"), {
    timeoutMs: 180_000,
    intervalMs: 5000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  expect(status).toBeUndefined();
  expect(clock).toBe(180_000);
});

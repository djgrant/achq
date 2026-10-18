import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Agent, collectPlan, Container, resetRegistry, Trigger, Workspace } from "@achq/core";
import { GitHubClient } from "../src/api/client.ts";
import { checkApp } from "../src/cli/app-check.ts";
import { configApp, configNeeds } from "../src/cli/config-app.ts";
import { installRepo, uninstallRepo } from "../src/cli/installation.ts";
import { repoOf } from "../src/cli/remote.ts";
import { readStatus } from "../src/cli/status.ts";
import { App, RepoPolicy } from "../src/resources/index.ts";

class TestAgent extends Agent {
  readonly agentKind = "test";
}

// The design's example config, declared directly.
const configPlan = () => {
  resetRegistry();
  const app = App.get("notation-achq");
  const code = new RepoPolicy("code", { app, permissions: { contents: "write", issues: "write", pull_requests: "write" } });
  const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });
  new Workspace("docs", { container: dev, threads: app.issues.where({ labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
  new Workspace("issues", { container: dev, threads: app.issues, branch: "issue-{number}", base: "main" });
  new Trigger("mention", { event: app.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: new TestAgent("coder", {}) });
  return collectPlan();
};

test("the App slug and what it needs come from the config", () => {
  const plan = configPlan();
  expect(configApp(plan)).toBe("notation-achq");
  expect(configNeeds(plan, "notation-achq")).toEqual({
    events: ["issue_comment", "push"],
    permissions: { metadata: "read", actions_variables: "write", issues: "write", contents: "write", pull_requests: "write" },
  });
});

test("a config naming two Apps, or none, is refused", () => {
  const plan = configPlan();
  const other = { name: "x", policy: { provider: "github", app: "other-app", repo: null, permissions: {} } };
  expect(() => configApp({ ...plan, policies: [...plan.policies, other] })).toThrow("several Apps (notation-achq, other-app)");
  expect(() => configApp({ ...plan, policies: [], workspaces: [], triggers: [] })).toThrow("names no GitHub App");
});

test("a repo comes from an https or ssh remote on GitHub", () => {
  const web = "https://github.com";
  expect(repoOf("https://github.com/notationlabs/yieldstar.git", web)).toBe("notationlabs/yieldstar");
  expect(repoOf("git@github.com:notationlabs/yieldstar.git", web)).toBe("notationlabs/yieldstar");
  expect(repoOf("https://github.com/djgrant/achq", web)).toBe("djgrant/achq");
  expect(repoOf("https://gitlab.com/notationlabs/yieldstar.git", web)).toBeUndefined();
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
  const plan = configPlan();
  expect(await checkApp(gh, "notation-achq", plan)).toEqual({ private: true });
});

test("a public App is compared with what the config needs", async () => {
  const plan = configPlan();
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

test("ACHQ_STATUS is read from the repository variable, and is undefined before the first deploy", async () => {
  expect(await readStatus(gh, "notationlabs/yieldstar")).toBeUndefined();
  fake.status = { value: JSON.stringify({ host: "github", repo: "notationlabs/yieldstar", source: "notation-achq", state: "deployed", at: "2026-10-17T10:02:00Z" }) };
  expect((await readStatus(gh, "notationlabs/yieldstar"))?.state).toBe("deployed");
});

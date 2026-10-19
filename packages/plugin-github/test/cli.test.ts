import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Agent, type Change, collectPlan, Container, type Context, plan, resetDeclarations, Trigger, Workspace } from "@achq/core";
import { githubChannel } from "../src/channels/index.ts";
import { configApp, configNeeds } from "../src/channels/config-app.ts";
import { App, RepoPolicy } from "../src/index.ts";
import { GitHubClient } from "../src/lib/client.ts";
import { githubRepoHost } from "../src/repo-hosts/index.ts";
import { repoOf } from "../src/repo-hosts/remote.ts";
import { readStatus } from "../src/repo-hosts/status.ts";

class TestAgent extends Agent {
  readonly runtime = "test";
}

// The design's example config, declared directly.
const configPlan = () => {
  resetDeclarations();
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
  const other = { name: "x", policy: { access: "github", app: "other-app", repo: null, permissions: {} } };
  expect(() => configApp({ ...plan, policies: [...plan.policies, other] })).toThrow("several Apps (notation-achq, other-app)");
  expect(() => configApp({ ...plan, policies: [], workspaces: [], triggers: [] })).toThrow("names no GitHub App");
});

test("a repo comes from an https or ssh remote on GitHub", () => {
  const web = "https://github.com";
  expect(repoOf("https://github.com/notationlabs/yieldstar.git", web)).toBe("notationlabs/yieldstar");
  expect(repoOf("git@github.com:notationlabs/yieldstar.git", web)).toBe("notationlabs/yieldstar");
  expect(repoOf("https://github.com/djgrant/achq", web)).toBe("djgrant/achq");
  expect(repoOf("https://gitlab.com/notationlabs/yieldstar.git", web)).toBeUndefined();
  // The repo host's, with the web URL the env points it at.
  expect(githubRepoHost.create({}).repoOf("git@github.com:notationlabs/yieldstar.git")).toBe("notationlabs/yieldstar");
  expect(githubRepoHost.create({ GITHUB_WEB_URL: "http://localhost:3000" }).repoOf("http://localhost:3000/o/r.git")).toBe("o/r");
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

const REPO = "notationlabs/yieldstar";
const FULL = { events: ["issues", "issue_comment", "push"], permissions: { contents: "write", issues: "write", pull_requests: "admin", metadata: "read", actions_variables: "write" } };
const web = () => `http://localhost:${server.port}/web`;

/** As the CLI plans it: your gh login (GH_TOKEN skips gh), the env's GitHub, and a browser that records what it opened. */
const installing = async (installed: boolean, opts: { open?: boolean } = {}) => {
  const log: string[] = [];
  const opened: string[] = [];
  const ctx: Context = {
    env: { GITHUB_API_URL: `http://localhost:${server.port}`, GITHUB_WEB_URL: web(), GH_TOKEN: "t" },
    log: (line) => log.push(line),
    ...(opts.open !== false && { open: async (url: string) => void opened.push(url) }),
    newSecret: () => "secret",
    sleep: async () => {},
  };
  const resources = githubChannel.create({}).installation(REPO, configPlan(), installed);
  return { planned: await plan(resources, ctx), log, opened };
};

const summary = (changes: Change[]) => changes.map((c) => `${c.op} ${c.target}${c.detail ? ` ${c.detail}` : ""}`);
const writes = () => fake.calls.filter((c) => !c.startsWith("GET "));

const orgInstall = (repos: string[], selection: "all" | "selected" = "selected") => [
  { id: 1, app_slug: "notation-achq", account: { login: "djgrant", type: "User" }, repository_selection: "selected" as const, repos: [] },
  { id: 2, app_slug: "notation-achq", account: { login: "NotationLabs", type: "Organization" }, repository_selection: selection, repos },
];

test("install adds the repo to the App's installation on its owner", async () => {
  fake.app = FULL;
  fake.installations = orgInstall(["notationlabs/other"]);
  const { planned } = await installing(true);
  expect(summary(planned.changes)).toEqual(["+ notation-achq on notationlabs/yieldstar"]);
  expect(planned.warnings).toEqual([]);
  expect(writes()).toEqual([]);

  await planned.apply();
  expect(writes()).toEqual(["PUT /user/installations/2/repositories/777"]);
  expect(fake.installations[1].repos).toContain(REPO);
});

test("install changes nothing when the repo is already in the installation, or it's on all repos", async () => {
  fake.app = FULL;
  fake.installations = orgInstall([REPO]);
  expect((await installing(true)).planned.changes).toEqual([]);
  fake.installations = orgInstall([], "all");
  fake.calls = [];
  expect((await installing(true)).planned.changes).toEqual([]);
  expect(fake.calls).not.toContain("GET /user/installations/2/repositories");
});

test("install with no installation on the owner opens GitHub's install page, on the env's web URL", async () => {
  fake.app = FULL;
  const { planned, log, opened } = await installing(true);
  expect(summary(planned.changes)).toEqual(["+ notation-achq on notationlabs opens GitHub to install it"]);
  await planned.apply();
  expect(opened).toEqual([`${web()}/apps/notation-achq/installations/new`]);
  expect(log).toEqual([`notation-achq isn't installed on notationlabs yet. Install it on ${REPO} at ${web()}/apps/notation-achq/installations/new`]);
  expect(writes()).toEqual([]);

  const headless = await installing(true, { open: false });
  await expect(headless.planned.apply()).rejects.toThrow("opens your browser");
});

test("install fails before installing when the App lacks the events or permissions the config needs", async () => {
  fake.app = { events: ["issues", "push"], permissions: { ...FULL.permissions, contents: "read" } };
  fake.installations = orgInstall([]);
  await expect(installing(true)).rejects.toThrow("notation-achq doesn't have what notationlabs/yieldstar's config needs: the issue_comment event, contents: write");
  expect(writes()).toEqual([]);
});

test("a private App's 404 skips the App comparison, with a warning", async () => {
  fake.installations = orgInstall([]);
  const { planned } = await installing(true);
  expect(summary(planned.changes)).toEqual(["+ notation-achq on notationlabs/yieldstar"]);
  expect(planned.warnings).toEqual(["notation-achq is private, so GitHub won't show its settings; skipping the App check"]);
});

test("uninstall removes the repo from the installation, and never reads the App", async () => {
  fake.installations = orgInstall([REPO, "notationlabs/other"]);
  const { planned, log } = await installing(false);
  expect(summary(planned.changes)).toEqual(["- notation-achq on notationlabs/yieldstar"]);
  expect(planned.warnings).toEqual([]);
  await planned.apply();
  expect(writes()).toEqual(["DELETE /user/installations/2/repositories/777"]);
  expect(fake.installations[1].repos).toEqual(["notationlabs/other"]);
  expect(log).toEqual(["notationlabs/yieldstar's containers sleep, and are kept until `achq up --prune`."]);
  expect(fake.calls.some((c) => c.startsWith("GET /apps/"))).toBe(false);

  // Not installed, or no installation at all: nothing to change.
  expect((await installing(false)).planned.changes).toEqual([]);
  fake.installations = [];
  expect((await installing(false)).planned.changes).toEqual([]);
});

test("uninstall from an installation on all repos can't be applied: it says where to choose repos, on the env's web URL", async () => {
  fake.installations = orgInstall([], "all");
  await expect(installing(false)).rejects.toThrow(`notation-achq is installed on all of NotationLabs's repos; choose repos at ${web()}/organizations/NotationLabs/settings/installations/2`);
  expect(writes()).toEqual([]);
});

test("ACHQ_STATUS is read from the repository variable, and is undefined before the first deploy", async () => {
  expect(await readStatus(gh, "notationlabs/yieldstar")).toBeUndefined();
  fake.status = { value: JSON.stringify({ host: "github", repo: "notationlabs/yieldstar", source: "notation-achq", state: "deployed", at: "2026-10-17T10:02:00Z" }) };
  expect((await readStatus(gh, "notationlabs/yieldstar"))?.state).toBe("deployed");
});

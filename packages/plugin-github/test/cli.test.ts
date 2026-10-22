import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Agent, type Change, collectManifest, Container, type Context, plan, resetDeclarations, Trigger, Workspace } from "@achq/core";
import { configSource, configNeeds } from "../src/lib/config-needs.ts";
import { Channel, Policy } from "../src/index.ts";
import { githubCodeHostProvider } from "../src/code-host/index.ts";

class TestAgent extends Agent {
  readonly runtime = "test";
}

// The design's example config, declared directly.
const configManifest = () => {
  resetDeclarations();
  const channel = Channel.get("notation-achq");
  const code = new Policy("code", { channel, permissions: { contents: "write", issues: "write", pull_requests: "write" } });
  const dev = new Container("dev", { image: "./Dockerfile", policies: [code] });
  new Workspace("docs", { container: dev, threads: channel.issues.where({ labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
  new Workspace("issues", { container: dev, threads: channel.issues, branch: "issue-{number}", base: "main" });
  new Trigger("mention", { event: channel.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: new TestAgent("coder", {}) });
  return collectManifest();
};

test("the App slug and what it needs come from the config", () => {
  const manifest = configManifest();
  expect(configSource(manifest)).toBe("notation-achq");
  expect(configNeeds(manifest, "notation-achq")).toEqual({
    events: ["issue_comment", "push"],
    permissions: { metadata: "read", actions_variables: "write", issues: "write", contents: "write", pull_requests: "write" },
  });
});

test("a config naming two Apps, or none, is refused", () => {
  const manifest = configManifest();
  const other = { name: "x", policy: { provider: "github", source: "other-app", repo: null, permissions: {} } };
  expect(() => configSource({ ...manifest, policies: [...manifest.policies, other] })).toThrow("several Apps (notation-achq, other-app)");
  expect(() => configSource({ ...manifest, policies: [], workspaces: [], triggers: [] })).toThrow("names no GitHub App");
});

test("a repo comes from an https or ssh remote on GitHub", () => {
  const github = githubCodeHostProvider.create({});
  expect(github.repoOf("https://github.com/notationlabs/yieldstar.git")).toBe("notationlabs/yieldstar");
  expect(github.repoOf("git@github.com:notationlabs/yieldstar.git")).toBe("notationlabs/yieldstar");
  expect(github.repoOf("https://github.com/djgrant/achq")).toBe("djgrant/achq");
  expect(github.repoOf("https://gitlab.com/notationlabs/yieldstar.git")).toBeUndefined();
  // On the web URL the env points it at.
  expect(githubCodeHostProvider.create({ GITHUB_WEB_URL: "http://localhost:3000" }).repoOf("http://localhost:3000/o/r.git")).toBe("o/r");
});

// ── A fake GitHub, as your gh login sees it, and the router ACHQ_STATUS names ──

/** What GitHub answers gh's token (an OAuth App's) on the routes that list a user's installations. */
const NOT_A_GITHUB_APP_TOKEN = "You must authenticate with an access token authorized to a GitHub App in order to list installations";

type Fake = {
  app?: { events: string[]; permissions: Record<string, string> };
  /** What the router says of the App on the repo, one answer per ask; the last repeats. */
  router: { installed: boolean; url: string }[];
  asked: { body: unknown; auth: string | null }[];
  status?: { value: string };
  calls: string[];
};
let fake: Fake;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const route = `${req.method} ${url.pathname}`;
      fake.calls.push(route);
      let m: RegExpMatchArray | null;
      if (route === "POST /router/installation") {
        fake.asked.push({ body: await req.json(), auth: req.headers.get("authorization") });
        return Response.json(fake.router.length > 1 ? fake.router.shift() : fake.router[0]);
      }
      if ((m = route.match(/^GET \/apps\/(.+)$/))) return fake.app ? Response.json({ slug: m[1], ...fake.app }) : new Response("Not Found", { status: 404 });
      if (url.pathname.startsWith("/user/installations")) return Response.json({ message: NOT_A_GITHUB_APP_TOKEN }, { status: 403 });
      if (route === "GET /repos/notationlabs/yieldstar/actions/variables/ACHQ_STATUS") {
        return fake.status ? Response.json({ name: "ACHQ_STATUS", ...fake.status }) : new Response("Not Found", { status: 404 });
      }
      return new Response(`no route ${route}`, { status: 500 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  fake = { router: [], asked: [], calls: [] };
});

const REPO = "notationlabs/yieldstar";
const FULL = { events: ["issues", "issue_comment", "push"], permissions: { contents: "write", issues: "write", pull_requests: "admin", metadata: "read", actions_variables: "write" } };
const web = () => `http://localhost:${server.port}/web`;
const api = () => `http://localhost:${server.port}`;
const SETTINGS = "https://github.com/organizations/NotationLabs/settings/installations/2";

/** The repo deployed before, so ACHQ_STATUS names the router, which says this of the App. */
const routerSays = (...answers: { installed: boolean; url: string }[]) => {
  fake.status = { value: JSON.stringify({ host: "github", repo: REPO, state: "deployed", at: "2026-10-17T10:02:00Z", router: `${api()}/router` }) };
  fake.router = answers;
};

/** As the CLI plans it: your gh login (GH_TOKEN skips gh), the env's GitHub, and a browser that records what it opened. */
const installing = async (installed: boolean, opts: { open?: boolean } = {}) => {
  const log: string[] = [];
  const opened: string[] = [];
  const env = { GITHUB_API_URL: api(), GITHUB_WEB_URL: web(), GH_TOKEN: "gho_t" };
  const ctx: Context = {
    env,
    log: (line) => log.push(line),
    ...(opts.open !== false && { open: async (url: string) => void opened.push(url) }),
    newSecret: () => "secret",
    sleep: async () => {},
  };
  const codeHost = githubCodeHostProvider.create(env);
  const resources = installed ? codeHost.install(REPO, configManifest()) : codeHost.uninstall(REPO, configManifest());
  return { planned: await plan(resources, ctx), log, opened };
};

const summary = (changes: Change[]) => changes.map((c) => `${c.op} ${c.target} ${c.what}${c.detail ? ` ${c.detail}` : ""}`);
const writes = () => fake.calls.filter((c) => !c.startsWith("GET ") && c !== "POST /router/installation");

test("gh's token can't list installations: GitHub refuses it, so install never asks", async () => {
  const res = await fetch(`${api()}/user/installations`, { headers: { authorization: "token gho_t" } });
  expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([403, NOT_A_GITHUB_APP_TOKEN]);
  fake.calls = [];
  fake.app = FULL;
  routerSays({ installed: false, url: SETTINGS });
  await (await installing(true)).planned.apply();
  routerSays({ installed: true, url: SETTINGS }, { installed: false, url: SETTINGS });
  await (await installing(false)).planned.apply();
  expect(fake.calls.filter((c) => c.includes("/user/installations"))).toEqual([]);
});

test("install asks the router ACHQ_STATUS names, with your gh token, and opens where the router says to add the repo", async () => {
  fake.app = FULL;
  routerSays({ installed: false, url: SETTINGS });
  const { planned, log, opened } = await installing(true);
  expect(summary(planned.changes)).toEqual(["+ notation-achq repo notationlabs/yieldstar, opens GitHub to install it"]);
  expect(planned.warnings).toEqual([]);
  expect(fake.asked).toEqual([{ body: { host: "github", repo: REPO, source: "notation-achq" }, auth: "Bearer gho_t" }]);

  await planned.apply();
  expect(opened).toEqual([SETTINGS]);
  expect(log).toEqual([`Install notation-achq on ${REPO} at ${SETTINGS}: on notationlabs, with ${REPO} among its repos.`]);
  expect(writes()).toEqual([]);
});

test("install changes nothing when the router says the App is installed on the repo", async () => {
  fake.app = FULL;
  routerSays({ installed: true, url: SETTINGS });
  expect((await installing(true)).planned.changes).toEqual([]);
});

test("install on a repo that's never been deployed, so has no router to ask, opens GitHub's install page, on the env's web URL", async () => {
  fake.app = FULL;
  const { planned, opened } = await installing(true);
  expect(summary(planned.changes)).toEqual(["+ notation-achq repo notationlabs/yieldstar, opens GitHub to install it"]);
  await planned.apply();
  expect(opened).toEqual([`${web()}/apps/notation-achq/installations/new`]);
  expect(fake.asked).toEqual([]);

  const headless = await installing(true, { open: false });
  await expect(headless.planned.apply()).rejects.toThrow("opens your browser");
});

test("install fails before installing when the App lacks the events or permissions the config needs", async () => {
  fake.app = { events: ["issues", "push"], permissions: { ...FULL.permissions, contents: "read" } };
  await expect(installing(true)).rejects.toThrow("notation-achq doesn't have what notationlabs/yieldstar's config needs: the issue_comment event, contents: write");
  expect(writes()).toEqual([]);
});

test("a private App's 404 skips the App comparison, with a warning", async () => {
  const { planned } = await installing(true);
  expect(summary(planned.changes)).toEqual(["+ notation-achq repo notationlabs/yieldstar, opens GitHub to install it"]);
  expect(planned.warnings).toEqual(["notation-achq is private, so GitHub won't show its settings; skipping the App check"]);
});

test("uninstall opens the installation's settings, and waits until the router says the repo's gone; it never reads the App", async () => {
  routerSays({ installed: true, url: SETTINGS }, { installed: true, url: SETTINGS }, { installed: true, url: SETTINGS }, { installed: false, url: SETTINGS });
  const { planned, log, opened } = await installing(false);
  expect(summary(planned.changes)).toEqual(["- notation-achq repo notationlabs/yieldstar, opens GitHub to remove it"]);
  await planned.apply();
  expect(opened).toEqual([SETTINGS]);
  expect(fake.asked).toHaveLength(4);
  expect(log.at(-1)).toBe("notationlabs/yieldstar's containers sleep, and are kept until `achq infra up --prune`.");
  expect(writes()).toEqual([]);
  expect(fake.calls.some((c) => c.startsWith("GET /apps/"))).toBe(false);

  // Not installed: nothing to change.
  routerSays({ installed: false, url: SETTINGS });
  expect((await installing(false)).planned.changes).toEqual([]);
});

test("uninstall without a router to ask says where to remove it instead", async () => {
  await expect(installing(false)).rejects.toThrow("achq can't tell whether notation-achq is installed on notationlabs/yieldstar: it has no ACHQ_STATUS naming its router yet");
});

test("ACHQ_STATUS is read from the repository variable, and is undefined before the first deploy", async () => {
  const codeHost = githubCodeHostProvider.create({ GITHUB_API_URL: `http://localhost:${server.port}`, GH_TOKEN: "t" });
  expect(await codeHost.status(REPO)).toBeUndefined();
  fake.status = { value: JSON.stringify({ host: "github", repo: REPO, state: "deployed", at: "2026-10-17T10:02:00Z" }) };
  expect((await codeHost.status(REPO))?.state).toBe("deployed");
});

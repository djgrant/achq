import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Agent, collectManifest, Container, resetDeclarations, Trigger, Workspace } from "@achq/core";
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
  const github = githubCodeHostProvider.asYou({});
  expect(github.repoOf("https://github.com/notationlabs/yieldstar.git")).toBe("notationlabs/yieldstar");
  expect(github.repoOf("git@github.com:notationlabs/yieldstar.git")).toBe("notationlabs/yieldstar");
  expect(github.repoOf("https://github.com/djgrant/achq")).toBe("djgrant/achq");
  expect(github.repoOf("https://gitlab.com/notationlabs/yieldstar.git")).toBeUndefined();
  // On the web URL the env points it at.
  expect(githubCodeHostProvider.asYou({ GITHUB_WEB_URL: "http://localhost:3000" }).repoOf("http://localhost:3000/o/r.git")).toBe("o/r");
});

// ── A fake GitHub, as your gh login sees it ──

type Fake = { app?: { events: string[]; permissions: Record<string, string> }; status?: { value: string }; calls: string[] };
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
      if ((m = route.match(/^GET \/apps\/(.+)$/))) return fake.app ? Response.json({ slug: m[1], ...fake.app }) : new Response("Not Found", { status: 404 });
      if (route === "DELETE /repos/notationlabs/yieldstar/actions/variables/ACHQ_STATUS") {
        if (!fake.status) return new Response("Not Found", { status: 404 });
        fake.status = undefined;
        return new Response(null, { status: 204 });
      }
      if (route === "GET /repos/notationlabs/yieldstar/actions/variables/ACHQ_STATUS") {
        return fake.status ? Response.json({ name: "ACHQ_STATUS", ...fake.status }) : new Response("Not Found", { status: 404 });
      }
      return new Response(`no route ${route}`, { status: 500 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  fake = { calls: [] };
});

const REPO = "notationlabs/yieldstar";
const FULL = { events: ["issues", "issue_comment", "push"], permissions: { contents: "write", issues: "write", pull_requests: "admin", metadata: "read", actions_variables: "write" } };
/** Your gh login (GH_TOKEN skips gh), on the fake's API and web URLs. */
const you = () => githubCodeHostProvider.asYou({ GITHUB_API_URL: `http://localhost:${server.port}`, GITHUB_WEB_URL: "http://localhost:3000", GH_TOKEN: "gho_t" });

test("the App is checked for what the config needs", async () => {
  fake.app = FULL;
  expect(await you().checkSource("notation-achq", configManifest())).toEqual({ missing: [], warnings: [] });
  fake.app = { events: ["issues", "push"], permissions: { ...FULL.permissions, contents: "read" } };
  expect(await you().checkSource("notation-achq", configManifest())).toEqual({ missing: ["the issue_comment event", "contents: write"], warnings: [] });
});

test("a private App's 404 skips the App comparison, with a warning", async () => {
  expect(await you().checkSource("notation-achq", configManifest())).toEqual({
    missing: [],
    warnings: ["notation-achq is private, so GitHub won't show its settings; skipping the App check"],
  });
});

test("the App's install page is on the env's web URL, and what to do there names the owner", () => {
  expect(you().installPage("notation-achq")).toBe("http://localhost:3000/apps/notation-achq/installations/new");
  expect(you().howTo("install", "notation-achq", REPO, "u")).toBe(`Install notation-achq on ${REPO} at u: on notationlabs, with ${REPO} among its repos.`);
  expect(you().howTo("remove", "notation-achq", REPO, "u")).toStartWith(`Remove ${REPO} from notation-achq's installation at u: under "Repository access"`);
});

test("ACHQ_STATUS is read from the repository variable, and is undefined before the first deploy; clearing it deletes it", async () => {
  expect(await you().status(REPO)).toBeUndefined();
  fake.status = { value: JSON.stringify({ repo: REPO, state: "deployed", at: "2026-10-17T10:02:00Z" }) };
  expect((await you().status(REPO))?.state).toBe("deployed");
  await you().clearStatus(REPO);
  expect(fake.status).toBeUndefined();
  expect(fake.calls.filter((c) => c.startsWith("DELETE "))).toEqual(["DELETE /repos/notationlabs/yieldstar/actions/variables/ACHQ_STATUS"]);
});

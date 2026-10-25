import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectManifest, resetDeclarations, type Status } from "@achq/core";
import { githubCodeHostProvider } from "@achq/github/code-host";
import { type FixDeps, fixInBrowser, loadRepoManifest, openInstall, planInstall, planUninstall, removeAndWait, waitForStatus } from "../src/lib/repo.ts";
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

const status = (at: string): Status => ({ repo: "notationlabs/yieldstar", state: "deployed", at, router: "https://achq-router.up.railway.app" });

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

// ── Installing and uninstalling, against a fake GitHub as your gh login sees it, and the router ACHQ_STATUS names ──

describe("install and uninstall", () => {
  /** What GitHub answers gh's token (an OAuth App's) on the routes that list a user's installations. */
  const NOT_A_GITHUB_APP_TOKEN = "You must authenticate with an access token authorized to a GitHub App in order to list installations";
  const REPO = "notationlabs/yieldstar";
  const FULL = { events: ["issues", "issue_comment", "push"], permissions: { contents: "write", issues: "write", pull_requests: "admin", metadata: "read", actions_variables: "write" } };
  const SETTINGS = "https://github.com/organizations/NotationLabs/settings/installations/2";

  type Fake = {
    app?: { events: string[]; permissions: Record<string, string> };
    /** What the router says of the App on the repo, one answer per ask; the last repeats. */
    router: { installed: boolean; url: string }[];
    /** The router ACHQ_STATUS names is torn down, so 404s. */
    routerGone?: boolean;
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
          if (fake.routerGone) return new Response("Not Found", { status: 404 });
          fake.asked.push({ body: await req.json(), auth: req.headers.get("authorization") });
          return Response.json(fake.router.length > 1 ? fake.router.shift() : fake.router[0]);
        }
        if ((m = route.match(/^GET \/apps\/(.+)$/))) return fake.app ? Response.json({ slug: m[1], ...fake.app }) : new Response("Not Found", { status: 404 });
        if (url.pathname.startsWith("/user/installations")) return Response.json({ message: NOT_A_GITHUB_APP_TOKEN }, { status: 403 });
        if (route === `DELETE /repos/${REPO}/actions/variables/ACHQ_STATUS`) {
          if (!fake.status) return new Response("Not Found", { status: 404 });
          fake.status = undefined;
          return new Response(null, { status: 204 });
        }
        if (route === `GET /repos/${REPO}/actions/variables/ACHQ_STATUS`) {
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

  const web = () => `http://localhost:${server.port}/web`;
  const api = () => `http://localhost:${server.port}`;
  let manifest: Awaited<ReturnType<typeof loadRepoManifest>>;
  beforeAll(async () => {
    manifest = await loadRepoManifest(repoDir);
  });

  /** The repo deployed before, so ACHQ_STATUS names the router, which says this of the App. */
  const routerSays = (...answers: { installed: boolean; url: string }[]) => {
    fake.status = { value: JSON.stringify({ repo: REPO, state: "deployed", at: "2026-10-17T10:02:00Z", router: `${api()}/router` }) };
    fake.router = answers;
  };

  /** As the CLI runs it: your gh login (GH_TOKEN skips gh), the env's GitHub, and a browser that records what it opened. */
  const cli = () => {
    const log: string[] = [];
    const opened: string[] = [];
    const codeHost = githubCodeHostProvider.asYou({ GITHUB_API_URL: api(), GITHUB_WEB_URL: web(), GH_TOKEN: "gho_t" });
    const here = { repo: REPO, codeHost };
    const deps = { log: (line: string) => void log.push(line), open: async (url: string) => void opened.push(url), wait: { sleep: async () => {} } };
    return {
      log,
      opened,
      install: async () => {
        const { source, url } = await planInstall(here, manifest, deps);
        if (url) await openInstall(here, source, url, deps);
        return url;
      },
      planUninstall: () => planUninstall(here, manifest, deps),
      uninstall: async () => {
        const { source, url } = await planUninstall(here, manifest, deps);
        if (url) await removeAndWait(here, source, url, deps);
        return url;
      },
    };
  };

  const writes = () => fake.calls.filter((c) => !c.startsWith("GET ") && c !== "POST /router/installation");

  test("gh's token can't list installations: GitHub refuses it, so install never asks", async () => {
    const res = await fetch(`${api()}/user/installations`, { headers: { authorization: "token gho_t" } });
    expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([403, NOT_A_GITHUB_APP_TOKEN]);
    fake.calls = [];
    fake.app = FULL;
    routerSays({ installed: false, url: SETTINGS });
    await cli().install();
    routerSays({ installed: true, url: SETTINGS }, { installed: false, url: SETTINGS });
    await cli().uninstall();
    expect(fake.calls.filter((c) => c.includes("/user/installations"))).toEqual([]);
  });

  test("install asks the router ACHQ_STATUS names, with your gh token, and opens where the router says to add the repo", async () => {
    fake.app = FULL;
    routerSays({ installed: false, url: SETTINGS });
    const { install, log, opened } = cli();
    expect(await install()).toBe(SETTINGS);
    expect(fake.asked).toEqual([{ body: { repo: REPO, source: "notation-achq" }, auth: "Bearer gho_t" }]);
    expect(opened).toEqual([SETTINGS]);
    expect(log).toEqual([`+ notation-achq on ${REPO}: opens your browser to install it`, `Install notation-achq on ${REPO} at ${SETTINGS}: on notationlabs, with ${REPO} among its repos.`]);
    expect(writes()).toEqual([]);
  });

  test("install changes nothing when the router says the App is installed on the repo", async () => {
    fake.app = FULL;
    routerSays({ installed: true, url: SETTINGS });
    const { install, log, opened } = cli();
    expect(await install()).toBeUndefined();
    expect(opened).toEqual([]);
    expect(log).toEqual([`notation-achq is already installed on ${REPO}`]);
  });

  test("install on a repo that's never been deployed, so has no router to ask, opens GitHub's install page, on the env's web URL", async () => {
    fake.app = FULL;
    const { install, opened } = cli();
    await install();
    expect(opened).toEqual([`${web()}/apps/notation-achq/installations/new`]);
    expect(fake.asked).toEqual([]);
  });

  test("install on a repo whose router is gone, e.g. its hq moved to another provider, opens GitHub's install page; uninstall says what to do", async () => {
    fake.app = FULL;
    routerSays();
    fake.routerGone = true;
    const { install, opened } = cli();
    await install();
    expect(opened).toEqual([`${web()}/apps/notation-achq/installations/new`]);
    await expect(cli().uninstall()).rejects.toThrow(`No router answers at ${api()}/router, which ${REPO}'s \`ACHQ_STATUS\` variable names: its hq may have been torn down`);
  });

  test("install fails before installing when the App lacks the events or permissions the config needs", async () => {
    fake.app = { events: ["issues", "push"], permissions: { ...FULL.permissions, contents: "read" } };
    await expect(cli().install()).rejects.toThrow(`notation-achq doesn't have what ${REPO}'s config needs: the issue_comment event, contents: write`);
    expect(writes()).toEqual([]);
  });

  test("a private App's 404 skips the App comparison, with a warning", async () => {
    const { install, log, opened } = cli();
    await install();
    expect(log[0]).toBe("! notation-achq is private, so GitHub won't show its settings; skipping the App check");
    expect(opened).toEqual([`${web()}/apps/notation-achq/installations/new`]);
  });

  test("uninstall opens the installation's settings, waits until the router says the repo's gone, then deletes ACHQ_STATUS; it never reads the App", async () => {
    routerSays({ installed: true, url: SETTINGS }, { installed: true, url: SETTINGS }, { installed: true, url: SETTINGS }, { installed: false, url: SETTINGS });
    const { uninstall, log, opened } = cli();
    expect(await uninstall()).toBe(SETTINGS);
    expect(opened).toEqual([SETTINGS]);
    expect(fake.asked).toHaveLength(4);
    expect(log[0]).toBe(`- notation-achq on ${REPO}: opens your browser to remove it`);
    expect(log.at(-1)).toBe(`${REPO}'s containers sleep, and are kept until \`achq infra up --prune\`.`);
    expect(writes()).toEqual([`DELETE /repos/${REPO}/actions/variables/ACHQ_STATUS`]);
    expect(fake.status).toBeUndefined();
    expect(fake.calls.some((c) => c.startsWith("GET /apps/"))).toBe(false);

    // Not installed: nothing to change.
    routerSays({ installed: false, url: SETTINGS });
    const again = cli();
    expect((await again.planUninstall()).url).toBeUndefined();
    expect(again.log).toEqual([`notation-achq isn't installed on ${REPO}`]);
  });

  test("uninstall gives up when the repo's still installed after the timeout", async () => {
    routerSays({ installed: true, url: SETTINGS });
    const codeHost = githubCodeHostProvider.asYou({ GITHUB_API_URL: api(), GITHUB_WEB_URL: web(), GH_TOKEN: "gho_t" });
    const deps = { log: () => {}, open: async () => {}, wait: { sleep: async () => {}, timeoutMs: 15_000, intervalMs: 5000 } };
    await expect(removeAndWait({ repo: REPO, codeHost }, "notation-achq", SETTINGS, deps)).rejects.toThrow(`notation-achq is still installed on ${REPO} after`);
    expect(fake.status).toBeDefined();
  });

  test("uninstall without a router to ask says where to remove it instead", async () => {
    await expect(cli().uninstall()).rejects.toThrow(`achq can't tell whether notation-achq is installed on ${REPO}: ${REPO}'s \`ACHQ_STATUS\` variable doesn't name its router yet`);
  });
});

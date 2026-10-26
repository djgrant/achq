import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectManifest, resetDeclarations, type Status } from "@achq/core";
import { githubCodeHostProvider } from "@achq/github/code-host";
import { createRawPrompter } from "@pokit/core";
import type { RepoHere } from "../io/workdir.ts";
import { repoEvaluateManifest } from "../tasks/repo.evaluate-manifest.ts";
import { repoInstall } from "../tasks/repo.install.ts";
import { repoReadStatus, STATUS_TIMEOUT_MS } from "../tasks/repo.read-status.ts";
import { repoUninstall } from "../tasks/repo.uninstall.ts";
import { run } from "../tasks/run.ts";
import { testRunner } from "./runner.ts";
import * as core from "@achq/core";
import * as claude from "@achq/claude";
import * as github from "@achq/github";

// A real .achq/ directory, as the design's example writes it, with a local import.
const CONFIG = `
import { Container, Workspace, Trigger } from "@achq/core";
import * as claude from "@achq/claude";
import * as github from "@achq/github";
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

/** The repo's manifest, as `achq repo install` evaluates it. */
const loadRepoManifest = async (dir: string) => run(testRunner(), repoEvaluateManifest, { dir });

/** Lets Bun import a repo config from outside achq, as the sandbox does. */
const registerConfigModules = () =>
  Bun.plugin({
    name: "achq-config",
    setup(build) {
      for (const [specifier, exports] of Object.entries({ "@achq/core": core, "@achq/claude": claude, "@achq/github": github })) build.module(specifier, () => ({ exports: { ...exports }, loader: "object" }));
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

const status = (at: string, router = "https://achq-router.up.railway.app"): Status => ({ repo: "notationlabs/yieldstar", state: "deployed", at, router });

/** Waits for the repo's status written after `since`, as `achq repo install` does, from `read`. */
const waitForStatus = async (read: () => Promise<Status | undefined>, repo: string, since: Date, { sleep }: { sleep: (ms: number) => Promise<void> }) =>
  run(testRunner(), repoReadStatus, { here: { repo, codeHost: { status: read } } as unknown as RepoHere, since, sleep });

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
    sleep: async (ms) => void (clock += ms),
  });
  expect(found).toBeUndefined();
  expect(clock).toBe(STATUS_TIMEOUT_MS);
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
    /** What happens when the router is asked to deploy the repo again. */
    redeployed?: (repo: string) => void;
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
        if (route === "POST /router/deploy") {
          fake.redeployed?.(((await req.json()) as { repo: string }).repo);
          return new Response("accepted", { status: 202 });
        }
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
    const params = { here, manifest, log: (line: string) => void log.push(line), open: async (url: string) => void opened.push(url), sleep: async () => {} };
    return {
      log,
      opened,
      /** Installs, and waits for the deploy's result, which the fake never writes. Where it opened, if anywhere. */
      install: async () => {
        await run(testRunner(), repoInstall, params);
        return opened[0];
      },
      planUninstall: async () => run(testRunner(), repoUninstall, { ...params, dryRun: true }),
      uninstall: async () => (await run(testRunner(), repoUninstall, params)).url,
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
    expect(log).toEqual([
      `+ notation-achq on ${REPO}: opens your browser to install it`,
      `Install notation-achq on ${REPO} at ${SETTINGS}: on notationlabs, with ${REPO} among its repos.`,
      "Waiting for the deploy's result…",
      "No result after 20 minutes. Run `achq infra up` to sync installs, then `achq repo status`.",
    ]);
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
    await expect(cli().uninstall()).rejects.toThrow(`notation-achq is still installed on ${REPO} after 15 minutes`);
    expect(fake.status).toBeDefined();
  });

  test("uninstall without a router to ask says where to remove it instead", async () => {
    await expect(cli().uninstall()).rejects.toThrow(`achq can't tell whether notation-achq is installed on ${REPO}: ${REPO}'s \`ACHQ_STATUS\` variable doesn't name its router yet`);
  });

  describe("a deploy that failed with something only you can fix", () => {
    const action = { url: "https://github.com/apps/cloudflare-workers-and-pages/installations/new", what: `install cloudflare-workers-and-pages on ${REPO}` };
    const deployed = (at: string) => status(at, `${api()}/router`);
    const failed = (at: string): Status => ({ ...deployed(at), state: "failed", error: `Workers Builds can't see ${REPO}`, action });

    /** Installed already, its deploy failed so, and ACHQ_STATUS as the deployer writes it: after each redeploy, the next of `outcomes`. */
    const world = (outcomes: Status[], interactive = true) => {
      const start = failed("2026-10-17T10:01:00Z");
      fake.app = FULL;
      routerSays({ installed: true, url: SETTINGS });
      fake.status = { value: JSON.stringify(start) };
      let clock = Date.parse("2026-10-17T10:05:00Z");
      const did: string[] = [];
      fake.redeployed = (repo) => {
        did.push(`redeploy ${repo} through the router`);
        fake.status = { value: JSON.stringify(outcomes.shift()!) };
      };
      const codeHost = githubCodeHostProvider.asYou({ GITHUB_API_URL: api(), GITHUB_WEB_URL: web(), GH_TOKEN: "gho_t" });
      // Pressing Enter once you've done it.
      const prompter = createRawPrompter({ selectResponses: true, onPrompt: () => void did.push("waited for you") });
      const install = async () =>
        run(testRunner(prompter), repoInstall, {
          here: { repo: REPO, codeHost },
          manifest,
          interactive,
          openUrl: (url) => void did.push(`open ${url}`),
          now: () => new Date(clock++),
          log: (line) => void did.push(line),
          sleep: async () => {},
        });
      return { start, install, did };
    };
    const fixing = [`notation-achq is already installed on ${REPO}`, `failed at 2026-10-17T10:01:00Z: Workers Builds can't see ${REPO}`, `to fix: ${action.what}, at ${action.url}`];

    test("opens it, waits for you, has the router deploy again, and waits for that result", async () => {
      const { install, did } = world([deployed("2026-10-17T10:06:00Z")]);
      expect((await install())?.status?.state).toBe("deployed");
      expect(did).toEqual([
        ...fixing,
        `The deploy needs you to ${action.what}.`,
        `Opening ${action.url} to ${action.what}…`,
        `open ${action.url}`,
        "waited for you",
        `redeploy ${REPO} through the router`,
        "Deploying again…",
        "deployed at 2026-10-17T10:06:00Z",
      ]);
    });

    test("tries again while it still needs you, a few times at most", async () => {
      const { install, did } = world([failed("2026-10-17T10:06:00Z"), failed("2026-10-17T10:07:00Z"), failed("2026-10-17T10:08:00Z"), deployed("2026-10-17T10:09:00Z")]);
      expect((await install())?.status?.state).toBe("failed");
      expect(did.filter((d) => d.startsWith("redeploy"))).toHaveLength(3);
    });

    test("without a terminal, says what to do and stops; any other result is left as it is", async () => {
      const { start, install, did } = world([], false);
      expect((await install())?.status).toEqual(start);
      expect(did).toEqual([...fixing, `To fix it, ${action.what} at ${action.url}, then run \`achq repo install\` again.`]);

      const other = world([]);
      fake.status = { value: JSON.stringify({ ...deployed("2026-10-17T10:01:00Z"), state: "failed", error: "broken" }) };
      expect(await other.install()).toBeUndefined();
      expect(other.did).toEqual([fixing[0]]);
    });
  });
});

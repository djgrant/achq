// The e2e's world: a repo with an `.achq/`, a fake GitHub holding it, and the
// real router, deployer and containers wired together over real HTTP.
import { expect } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContainerProvider, ContainerSpec } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";
import { createAgent, type Runner, readState } from "@achq/container";
import { createDeployer, deployerHandler, routerClient } from "@achq/deployer";
import { githubChannelProvider } from "@achq/github/channel";
import { githubCodeHostProvider } from "@achq/github/code-host";
import { githubPolicyProvider } from "@achq/github/policy";
import { createRouter } from "@achq/router";
import { fakeClaude } from "@achq/test-utils/fake-claude";
import { FakeGitHub, makeApp } from "@achq/test-utils/github";
import { makeOrigin } from "@achq/test-utils/origin";
import { tempDir } from "@achq/test-utils/temp-dir";
import { privateEnv } from "achq/registry";
import { APP_EVENTS, APP_ID, APP_PERMISSIONS, BOT, DJ, githubSends, INSTALLATION, KEY, MALLORY, OWNER, REPO, SLUG } from "./github-sends.ts";

export const THREAD = (n: number) => `github:${REPO}#${n}`;

// ─── The repo ────────────────────────────────────────────────────────────────

/** `.achq/config.ts`; `review` adds a second container, and `broken` makes it throw. */
export const configTs = ({ review = false, broken = false } = {}) => `
import { Container, Workspace, Trigger } from "achq";
import * as github from "achq/github";
import { channel } from "./channel.ts";
import { coder } from "./agents/coder.ts";
${broken ? `\nthrow new Error("broken");\n` : ""}
const code = new github.Policy("code", { channel, permissions: { contents: "write", issues: "write", pull_requests: "write" } });

const dev = new Container("dev", {
  image: "./Dockerfile",
  policies: [code],
  files: { "~/.config/yieldstar.toml": "./yieldstar.toml" },
});

new Workspace("docs", { container: dev, threads: channel.issues.where({ labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: channel.issues, branch: "issue-{number}", base: "main" });
${
  review
    ? `
const review = new Container("review", { image: "./Dockerfile", policies: [code] });
new Workspace("review", { container: review, threads: channel.issues.where({ labels: ["review"] }), branch: "review-{number}", base: "main" });
`
    : ""
}
new Trigger("mention", { event: channel.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });
new Trigger("opened", { event: channel.issue({ actions: ["opened"] }), agent: coder });
`;

const ACHQ: Record<string, string> = {
  ".achq/config.ts": configTs(),
  ".achq/channel.ts": `
import * as github from "achq/github";
export const channel = github.Channel.get("${SLUG}");
`,
  ".achq/agents/coder.ts": `
import * as claude from "achq/claude";
const deny = ["secrets", "keys"].map((dir) => \`Read(./\${dir}/**)\`);
export const coder = new claude.Agent("coder", { model: "claude-opus-5-5", effort: "high", systemPrompt: "./prompts/system.md", settings: { permissions: { deny } } });
`,
  ".achq/prompts/system.md": "You maintain yieldstar. Keep changes small.\n",
  ".achq/yieldstar.toml": "level = 1\n",
  ".achq/Dockerfile": "FROM oven/bun:1\n",
};

// ─── The container provider ──────────────────────────────────────────────────

type Hosted = {
  spec: ContainerSpec;
  runner: Runner;
  server: ReturnType<typeof Bun.serve>;
  /** What reached the runner. */
  requests: { method: string; path: string }[];
  /** Requests answered 503 from now on, as a container waking from sleep does. */
  asleepFor: number;
};

/**
 * Each ensured container is a real runner on a real port, started from the env
 * the deployer gave it. Containers can sleep, and restart on their volume.
 */
class TestContainerProvider implements ContainerProvider {
  readonly containers = new Map<string, Hosted>();
  readonly specs: ContainerSpec[] = [];
  readonly builds: string[] = [];
  readonly removed: string[] = [];
  readonly logs: string[] = [];
  /** Runners of containers that restarted, never to act again: their runs hang until the e2e ends. */
  private crashed: Runner[] = [];

  constructor(private local: (spec: ContainerSpec) => Record<string, string>) {}

  private id = (repo: string, name: string) => `${repo.toLowerCase()}/${name}`;

  get(repo: string, name: string) {
    const hosted = this.containers.get(this.id(repo, name));
    if (!hosted) throw new Error(`no container ${repo}/${name}`);
    return hosted;
  }

  /** What the container sees: the spec's env, plus what the image and its volume would provide. */
  private runnerFor(spec: ContainerSpec) {
    return createAgent({ ...spec.env, ...this.local(spec) }, { log: (line) => this.logs.push(`${spec.name}: ${line}`) });
  }

  async ensure(spec: ContainerSpec) {
    this.specs.push(spec);
    const id = this.id(spec.repo, spec.name);
    let hosted = this.containers.get(id);
    if (!hosted) {
      const requests: Hosted["requests"] = [];
      const server = Bun.serve({
        port: 0,
        fetch: (req) => {
          const h = this.containers.get(id)!;
          if (h.asleepFor > 0) {
            h.asleepFor--;
            return new Response("Application is waking up", { status: 503 });
          }
          requests.push({ method: req.method, path: new URL(req.url).pathname });
          return h.runner.fetch(req);
        },
      });
      hosted = { spec, runner: this.runnerFor(spec), server, requests, asleepFor: 0 };
      this.containers.set(id, hosted);
    }
    hosted.spec = spec;
    return { url: `http://localhost:${hosted.server.port}` };
  }
  async deploy(repo: string, name: string) {
    this.get(repo, name);
    this.builds.push(this.id(repo, name));
  }
  async list() {
    return [...this.containers.values()].map(({ spec }) => ({ repo: spec.repo, name: spec.name }));
  }
  async remove(repo: string, name: string) {
    const id = this.id(repo, name);
    this.containers.get(id)?.server.stop(true);
    this.containers.delete(id);
    this.removed.push(id);
  }
  async locate(repo: string, name: string) {
    return { containerProvider: "test", service: this.id(repo, name) };
  }

  /** The container answers 503 to the next `attempts` requests. */
  sleep(repo: string, name: string, attempts: number) {
    this.get(repo, name).asleepFor = attempts;
  }

  /**
   * The container dies and starts again on its volume, at the same URL. What
   * dies with it: its runs, and the locks they held, which the kernel frees.
   * The old runner is left waiting on its hung runs, so it never acts again.
   */
  async restart(repo: string, name: string) {
    const hosted = this.get(repo, name);
    const locks = path.join(hosted.runner.paths.data, "locks");
    const ps = await $`ps -axo pid=,command=`.quiet().text();
    for (const line of ps.split("\n")) {
      const [pid, ...command] = line.trim().split(/\s+/);
      if (command[0] === "perl" && command.join(" ").includes(locks)) process.kill(Number(pid), "SIGKILL");
    }
    this.crashed.push(hosted.runner);
    hosted.runner = this.runnerFor(hosted.spec);
    await hosted.runner.reportInterrupted();
  }

  /** Waits for every live container's runs to finish. */
  async idle() {
    await Promise.all([...this.containers.values()].map((c) => c.runner.idle()));
  }

  /** Once their hung runs are killed, lets the crashed runners finish before their volumes go. */
  async stop() {
    await Promise.all(this.crashed.map((r) => r.idle()));
    for (const c of this.containers.values()) c.server.stop(true);
  }
}

// ─── The world ───────────────────────────────────────────────────────────────

const adminJson = async <T>(base: string, method: string, route: string, body?: unknown): Promise<T> => {
  const res = await signedFetch(adminSecret(KEY), `${base}${route}`, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

const serve = (stops: (() => void)[], fetch: (req: Request) => Promise<Response>) => {
  const server = Bun.serve({ port: 0, fetch });
  stops.push(() => server.stop(true));
  return `http://localhost:${server.port}`;
};

export const startWorld = async () => {
  const dirs: string[] = [];
  const stops: (() => void)[] = [];
  const logs: string[] = [];
  const routerRequests: { port: "public" | "private"; method: string; path: string }[] = [];

  const root = tempDir(dirs);
  const repo = await makeOrigin(root, ACHQ, { "docs/index.md": "# Docs\n" });
  const claude = fakeClaude(root);

  // GitHub, with the App installed on the org (selected repos: yieldstar).
  const app = makeApp(SLUG, APP_ID, APP_PERMISSIONS, APP_EVENTS);
  const github = new FakeGitHub([app]).start();
  stops.push(() => github.stop());
  // Installation tokens last an hour, as GitHub's do.
  github.expiresAt = () => new Date(Date.now() + 60 * 60_000).toISOString();
  github.userTokens.set("gho_djgrant", { login: DJ.user.login, push: [REPO] });
  github.userTokens.set("gho_mallory", { login: MALLORY.user.login, push: [] });
  github.installations.push({ id: INSTALLATION, app: SLUG, account: OWNER, permissions: app.permissions, repos: [REPO] });
  github.addRepo(REPO, repo.origin);
  // Issues DJ opened before the App was installed.
  const issue = (number: number, title: string, body: string, labels: string[]) =>
    github.addIssue(REPO, { number, title, body, user: { login: DJ.user.login, type: "User" }, author_association: DJ.association, labels: labels.map((name) => ({ name })) });
  issue(42, "Regenerate the docs index", "The docs index is out of date since the API rename.", ["docs"]);
  issue(43, "Flaky settlement test", "settlement.test.ts fails about one run in ten.", ["bug"]);
  issue(44, "Bump the toolchain", "Bun 1.4 is out.", []);
  issue(7, "Rename the settlement API", "The PR for the rename.", []);
  issue(46, "Review the fee schedule", "Fees changed in Q3.", ["review"]);

  // The router: the side that holds the App's key.
  const routerDir = path.join(root, "router");
  const githubEnv = { ACHQ_GITHUB_APPS: JSON.stringify(github.keys()), GITHUB_API_URL: github.url, AGENT_WEBHOOK_KEY: KEY };
  const codeHostProviders = { github: githubCodeHostProvider.create(githubEnv) };
  let deployerFetch: (req: Request) => Promise<Response> = async () => new Response("starting", { status: 503 });
  const deployerUrl = serve(stops, (req) => deployerFetch(req));
  const router = createRouter({
    channelProviders: [githubChannelProvider.create(githubEnv)],
    policyProviders: [githubPolicyProvider.create(githubEnv)],
    key: KEY,
    dataDir: routerDir,
    deployerUrl,
    delays: [20, 50, 100, 200],
    attemptTimeout: 30_000,
    codeHostProviders,
    log: (line) => logs.push(`router: ${line}`),
  });
  await router.start();
  const routerPublic = serve(stops, (req) => {
    routerRequests.push({ port: "public", method: req.method, path: new URL(req.url).pathname });
    return router.publicFetch(req);
  });
  const routerPrivate = serve(stops, (req) => {
    routerRequests.push({ port: "private", method: req.method, path: new URL(req.url).pathname });
    return router.privateFetch(req);
  });

  // Containers: what the image and the container provider provide besides the deployer's env.
  const containerProvider = new TestContainerProvider((spec) => ({
    DATA_DIR: path.join(root, "containers", spec.name),
    ACHQ_REPO_URL: repo.origin,
    ACHQ_CLAUDE_BIN: claude.bin,
    GITHUB_API_URL: github.url,
    PATH: process.env.PATH!,
    FAKE_CLAUDE_LOG: claude.log,
  }));

  // The deployer, reaching the router on its private port.
  const deployer = createDeployer({
    containerProvider,
    router: routerClient({ url: routerPrivate, key: KEY }),
    owners: [OWNER],
    dataDir: path.join(root, "deployer"),
    codeHostProviders,
    env: { containerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-token" }, privateEnv: privateEnv(), key: KEY, routerUrl: routerPrivate, routerPublicUrl: routerPublic, ref: "e2e" },
    log: (line) => logs.push(`deployer: ${line}`),
  });
  deployerFetch = deployerHandler(deployer, KEY, (line) => logs.push(`deployer: ${line}`));

  const container = (name: string) => containerProvider.get(REPO, name);
  const dev = () => container("dev");

  return {
    root,
    repo,
    claude,
    github,
    router,
    routerDir,
    routerPublic,
    routerPrivate,
    routerRequests,
    containerProvider,
    sends: githubSends(github, () => routerPublic),
    container,
    dev,

    /** Waits for a condition the system reaches asynchronously, failing with `what` if it doesn't. */
    async until(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}\n${[...logs, ...containerProvider.logs].slice(-30).join("\n")}`);
        await Bun.sleep(10);
      }
    },

    /** Every delivery the router accepted has reached its targets, and every run they started has finished. */
    async settle() {
      await router.settled();
      await containerProvider.idle();
    },

    /** Commits `files` on main and pushes, as GitHub delivers it. */
    async push(files: Record<string, string>, message = "change") {
      const { before, after } = await repo.commit(files, message);
      return { after, sent: await this.sends.push(before, after, { modified: Object.keys(files) }, message) };
    },

    /** An admin-signed request to the router's private port, as the deployer makes them. */
    admin: <T>(method: string, route: string) => adminJson<T>(routerPrivate, method, route),

    /** An admin-signed request to the router's public port, as the infra CLI makes them. */
    infraCli: <T>(method: string, route: string, body?: unknown) => adminJson<T>(routerPublic, method, route, body),

    routerClaims() {
      const file = path.join(routerDir, "claims", `${REPO.toLowerCase().replace("/", "__")}.json`);
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, string>>) : {};
    },

    /** Deliveries no target answered, by delivery ID. */
    failedDeliveries() {
      const dir = path.join(routerDir, "failed");
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    },

    /** Events that reached a container. */
    events: (name = "dev") => container(name).requests.filter((r) => r.method === "POST" && r.path === "/events").length,
    threadState: (n: number, name = "dev") => readState(container(name).runner.paths.thread(THREAD(n))),
    worktree: (workspace: string, n: number, name = "dev") => container(name).runner.paths.worktree(workspace, THREAD(n)),
    replies: (n: number) => github.comments(REPO, n).filter((c) => c.user.login === BOT),
    branchOf: async (dir: string) => (await $`git -C ${dir} branch --show-current`.quiet().text()).trim(),
    credentialFetches: () => routerRequests.filter((r) => r.path === "/credentials").length,

    async stop() {
      if (process.env.E2E_LOGS) console.log([...logs, ...containerProvider.logs].join("\n"));
      await router.settled();
      await containerProvider.idle();
      claude.kill();
      await containerProvider.stop();
      for (const stop of stops.splice(0).reverse()) stop();
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

export type World = Awaited<ReturnType<typeof startWorld>>;

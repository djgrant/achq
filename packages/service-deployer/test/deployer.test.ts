import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserActionNeeded, STATUS_VARIABLE, type DeployerEnvelope } from "@achq/core";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";
import { evaluateConfig } from "../src/config/evaluate.ts";
import { DOC_CONFIG, DOC_PLAN } from "@achq/test-utils/config";
import { createDeployer } from "../src/deployer.ts";
import { githubChannelProvider } from "@achq/github/channel";
import { githubCodeHostProvider } from "@achq/github/code-host";
import { FakeGitHub } from "@achq/test-utils/github";
import { FakeRouter } from "@achq/test-utils/deployer/router";
import { MemoryContainerProvider } from "@achq/test-utils/deployer/container-provider";
import { dirStores } from "@achq/test-utils/stores";
import { routerClient } from "../src/router-client.ts";
import { deployerHandler } from "../src/server.ts";

const KEY = "test-webhook-key";
const REPO = "notationlabs/yieldstar";
const APP = "notation-achq";
const ENV = { containerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "claude-token" }, privateEnv: ["RAILWAY_API_TOKEN", "ACHQ_GITHUB_APPS"], key: KEY, routerUrl: "http://router.internal:8081", routerPublicUrl: "https://router.example", ref: "abc123" };

const repoFiles = (overrides: Record<string, string | undefined> = {}) => {
  const files: Record<string, string | undefined> = {
    "README.md": "# yieldstar",
    "src/index.ts": "export {};",
    ".achq/config.ts": DOC_CONFIG["config.ts"],
    ".achq/agents.ts": DOC_CONFIG["agents.ts"],
    ".achq/Dockerfile": "FROM oven/bun:1\n",
    ".achq/prompts/system.md": "You are a coder.",
    ".achq/prompts/triage.md": "You triage.",
    ".achq/foo.toml": "x = 1",
    ...overrides,
  };
  return Object.fromEntries(Object.entries(files).filter((e): e is [string, string] => e[1] !== undefined));
};

/** The deployer's GitHub code host, as main.ts builds it from the registry. */
const DEPLOYER_PERMISSIONS = { contents: "read", metadata: "read", actions_variables: "write" };
const githubDeps = () => {
  const env = { GITHUB_API_URL: github.url };
  return { codeHostProviders: { github: githubCodeHostProvider.create(env) } };
};

let github: FakeGitHub;
let router: FakeRouter;
let containerProvider: MemoryContainerProvider;
let dataDir: string;
let evaluations: number;
let clock: number;
let logs: string[];

const makeDeployer = (options: { owners?: string[]; env?: typeof ENV } = {}) =>
  createDeployer({
    containerProvider,
    router: routerClient({ url: router.url, key: KEY }),
    owners: options.owners ?? ["NotationLabs", "djgrant"],
    stores: dirStores(dataDir),
    ...githubDeps(),
    evaluate: (files) => {
      evaluations++;
      return evaluateConfig(files);
    },
    now: () => new Date(Date.UTC(2026, 9, 17, 10, 0, clock++)),
    env: options.env ?? ENV,
    log: (line) => logs.push(line),
  });

let n = 0;
/** An event as the real GitHub channel parses it from a webhook payload shaped like GitHub's. */
const event = (type: string, repos: string[], source = APP): DeployerEnvelope => {
  const [name, action] = type.split(".");
  const installation = { id: 7, account: { login: repos[0]!.split("/")[0] } };
  const list = repos.map((full_name) => ({ full_name }));
  const payload =
    name === "push"
      ? { ref: "refs/heads/main", after: "abc", repository: { full_name: repos[0], default_branch: "main" }, commits: [{ added: [".achq/config.ts"], modified: [], removed: [] }] }
      : name === "installation"
        ? { action, installation, repositories: list }
        : { action, installation, [`repositories_${action}`]: list };
  const parsed = githubChannelProvider.create({}).parse(source, new Headers({ "x-github-event": name!, "x-github-delivery": `d-${++n}` }), JSON.stringify(payload));
  if (parsed?.host === undefined) throw new Error(`the GitHub channel ignored ${type}, or didn't name its host`);
  return { event: parsed };
};

beforeEach(() => {
  github = new FakeGitHub().start();
  router = new FakeRouter(KEY, github);
  router.sources = [{ channel: "github", source: APP, events: ["issue_comment", "issues", "push", "installation"], permissions: { contents: "write", actions_variables: "write" } }];
  router.installed = [{ host: "github", repo: REPO }];
  containerProvider = new MemoryContainerProvider();
  dataDir = mkdtempSync(join(tmpdir(), "achq-deployer-"));
  evaluations = 0;
  clock = 0;
  logs = [];
});

afterEach(() => {
  github.stop();
  router.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("install", () => {
  test("deploys the repo and reports it in ACHQ_STATUS", async () => {
    const commit = github.commit(REPO, repoFiles());
    const deployer = makeDeployer();
    expect(await deployer.handle(event("installation.created", [REPO]))).toBe(true);

    expect(router.mints).toEqual([{ repo: REPO, policies: [{ provider: "github", repo: REPO, permissions: { ...DEPLOYER_PERMISSIONS } }] }]);

    expect(containerProvider.ops()).toEqual([
      { op: "ensure", repo: REPO, name: "dev" },
      { op: "deploy", repo: REPO, name: "dev" },
    ]);
    expect(containerProvider.services.get(`${REPO}/dev`)!.spec).toEqual({
      host: "github",
      repo: REPO,
      name: "dev",
      dockerfile: ".achq/Dockerfile",
      branch: "main",
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
        ACHQ_REPO: REPO,
        ACHQ_REPO_URL: `https://github.com/${REPO}.git`,
        ACHQ_CONTAINER: "dev",
        ACHQ_CONTAINER_SECRET: containerSecret(KEY, REPO, "dev"),
        ACHQ_ROUTER_URL: ENV.routerUrl,
        ACHQ_REF: ENV.ref,
        ACHQ_PRIVATE_ENV: "RAILWAY_API_TOKEN,ACHQ_GITHUB_APPS",
      },
    });

    const declared = DOC_PLAN.policies[0]!.policy;
    expect(router.validations).toEqual([{ repo: REPO, policies: [declared] }]);
    expect(router.repos.get(REPO)).toEqual({
      host: "github",
      repo: REPO,
      commit,
      containers: [{ name: "dev", url: "http://dev.notationlabs-yieldstar.internal:3000", policies: [declared] }],
      workspaces: DOC_PLAN.workspaces,
      triggers: DOC_PLAN.triggers.map(({ name, event }) => ({ name, event })),
    } as never);

    expect(github.variable(REPO, STATUS_VARIABLE)).toEqual({
      host: "github",
      repo: REPO,
      state: "deployed",
      at: "2026-10-17T10:00:00.000Z",
      commit,
      containers: [{ name: "dev", location: { containerProvider: "memory", service: `${REPO}/dev` } }],
      router: "https://router.example",
    });
    const { router: _router, ...record } = github.variable(REPO, STATUS_VARIABLE);
    expect(await deployer.status()).toEqual([record]);
  });

  test("installing on several repos deploys each, each with its own ACHQ_STATUS", async () => {
    const other = "djgrant/notes";
    github.commit(REPO, repoFiles());
    github.commit(other, repoFiles({ ".achq/config.ts": `throw new Error("broken");` }));
    await makeDeployer().handle(event("installation_repositories.added", [REPO, other]));
    expect(github.variable(REPO, STATUS_VARIABLE).state).toBe("deployed");
    expect(github.variable(other, STATUS_VARIABLE)).toMatchObject({ state: "failed", error: ".achq/config.ts: The config threw: Error: broken" });
    expect(router.mints.map((m) => m.repo)).toEqual([REPO, other]);
  });

  test("a disallowed owner is recorded as failed and its config is never fetched or evaluated", async () => {
    github.commit("stranger/repo", repoFiles());
    const deployer = makeDeployer();
    await deployer.handle(event("installation.created", ["stranger/repo"]));
    expect(evaluations).toBe(0);
    expect(router.mints).toEqual([]);
    expect(github.requests).toEqual([]);
    expect(containerProvider.ops()).toEqual([]);
    expect(router.count("PUT", "/admin/repos")).toBe(0);
    expect(await deployer.status()).toEqual([{ host: "github", repo: "stranger/repo", state: "failed", at: expect.any(String), error: "stranger isn't an owner this deployer serves" }]);
  });

  test("owners match case-insensitively", async () => {
    github.commit(REPO, repoFiles());
    const outcome = await makeDeployer({ owners: ["NOTATIONLABS"] }).deploy("github", REPO);
    expect(outcome.outcome).toBe("deployed");
  });

  test("a config that fails in the sandbox is reported in ACHQ_STATUS and deploys nothing", async () => {
    github.commit(REPO, repoFiles({ ".achq/config.ts": `import { Container } from "achq"; while (true) {}` }));
    const deployer = createDeployer({
      containerProvider,
      router: routerClient({ url: router.url, key: KEY }),
      owners: ["notationlabs"],
      stores: dirStores(dataDir),
      ...githubDeps(),
      evaluate: (files) => evaluateConfig(files, { timeoutMs: 200 }),
      env: ENV,
      log: () => {},
    });
    expect((await deployer.deploy("github", REPO)).outcome).toBe("failed");
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "failed", error: ".achq/config.ts: The config ran for longer than 200ms and was stopped" });
    expect(containerProvider.ops()).toEqual([]);
    expect(router.repos.size).toBe(0);

    github.commit(REPO, repoFiles({ ".achq/config.ts": `import "node:fs";` }));
    await deployer.deploy("github", REPO);
    expect(github.variable(REPO, STATUS_VARIABLE).error).toContain(`imports "node:fs"`);
  });

  test("a repo with no .achq/config.ts fails clearly", async () => {
    github.commit(REPO, { "README.md": "hi" });
    expect(await makeDeployer().deploy("github", REPO)).toMatchObject({ outcome: "failed", error: "there's no .achq/config.ts on main" });
    expect(evaluations).toBe(0);
    expect(github.variable(REPO, STATUS_VARIABLE).state).toBe("failed");
  });

  test(".achq/ over the size or file limits fails before evaluating", async () => {
    github.commit(REPO, repoFiles({ ".achq/big.ts": `export const s = "${"x".repeat(2 * 1024 * 1024)}";` }));
    expect((await makeDeployer().deploy("github", REPO)).error).toContain("the limit is 1048576");
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`.achq/lib/f${i}.ts`, "export {};"]));
    github.commit(REPO, repoFiles(many));
    expect((await makeDeployer().deploy("github", REPO)).error).toContain("source files; the limit is 200");
    expect(evaluations).toBe(0);
  });
});

describe("checks", () => {
  test("a validation failure from the router stops the deploy", async () => {
    router.problems = (policy) => (policy.permissions && (policy.permissions as Record<string, string>).pull_requests ? [`${APP} doesn't have pull_requests: write`] : []);
    github.commit(REPO, repoFiles());
    expect(await makeDeployer().deploy("github", REPO)).toMatchObject({ outcome: "failed", error: `${APP} doesn't have pull_requests: write` });
    expect(containerProvider.ops()).toEqual([]);
    expect(router.count("PUT", "/admin/repos")).toBe(0);
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "failed", error: `${APP} doesn't have pull_requests: write` });
  });

  test("a trigger wanting an event the App doesn't send stops the deploy", async () => {
    router.sources[0]!.events = ["issues"];
    github.commit(REPO, repoFiles());
    expect((await makeDeployer().deploy("github", REPO)).error).toBe(`trigger mention wants issue_comment, which ${APP} doesn't send`);
    expect(containerProvider.ops()).toEqual([]);
  });

  test("config that names an App the router doesn't know fails", async () => {
    github.commit(REPO, repoFiles({ ".achq/config.ts": DOC_CONFIG["config.ts"].replace(`Channel.get("notation-achq")`, `Channel.get("ghost")`) }));
    const { error } = await makeDeployer().deploy("github", REPO);
    expect(error).toContain("policy code names ghost, which the router doesn't know");
    expect(error).toContain("workspace docs names github:ghost, which the router doesn't know");
    expect(containerProvider.ops()).toEqual([]);
  });

  test("a missing Dockerfile fails; a trigger no workspace covers is a warning", async () => {
    github.commit(REPO, repoFiles({ ".achq/Dockerfile": undefined }));
    expect((await makeDeployer().deploy("github", REPO)).error).toBe("container dev's image .achq/Dockerfile doesn't exist");

    router.sources.push({ channel: "github", source: "second", events: ["issues"], permissions: {} });
    const config = `${DOC_CONFIG["config.ts"]}\nnew Trigger("lonely", { event: github.Channel.get("second").issue(), agent: triage });`;
    github.commit(REPO, repoFiles({ ".achq/config.ts": config }));
    const outcome = await makeDeployer().deploy("github", REPO);
    expect(outcome).toMatchObject({ outcome: "deployed", warnings: ["trigger lonely never runs: no workspace's threads come from github:second"] });
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "deployed", warnings: outcome.warnings });
  });
});

describe("config changes", () => {
  test("a repo on another host deploys again, even with the same .achq tree", async () => {
    github.commit(REPO, repoFiles());
    const github2 = githubCodeHostProvider.create({ GITHUB_API_URL: github.url });
    const deployer = createDeployer({
      containerProvider,
      router: routerClient({ url: router.url, key: KEY }),
      ...githubDeps(),
      codeHostProviders: { ...githubDeps().codeHostProviders, mirror: github2 },
      owners: ["notationlabs"],
      stores: dirStores(dataDir),
      env: ENV,
      log: () => {},
    });
    expect((await deployer.deploy("github", REPO)).outcome).toBe("deployed");
    expect((await deployer.deploy("github", REPO)).outcome).toBe("unchanged");
    expect((await deployer.deploy("mirror", REPO)).outcome).toBe("deployed");
    expect(containerProvider.services.get(`${REPO}/dev`)!.spec.host).toBe("mirror");
    router.installed = [{ host: "github", repo: REPO }];
    expect((await deployer.sync()).deployed).toEqual([REPO]);
    expect(containerProvider.services.get(`${REPO}/dev`)!.spec.host).toBe("github");
  });

  test("a new token for the agents deploys again, with the same .achq tree, and builds nothing", async () => {
    github.commit(REPO, repoFiles());
    expect((await makeDeployer().deploy("github", REPO)).outcome).toBe("deployed");
    const builds = containerProvider.ops().filter((o) => o.op === "deploy").length;
    const renewed = { ...ENV, containerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "new-token" } };
    expect((await makeDeployer({ env: renewed }).deploy("github", REPO)).outcome).toBe("deployed");
    expect(containerProvider.services.get(`${REPO}/dev`)!.spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("new-token");
    expect(containerProvider.ops().filter((o) => o.op === "deploy").length).toBe(builds);
    expect((await makeDeployer({ env: renewed }).deploy("github", REPO)).outcome).toBe("unchanged");
  });

  test("a host achq doesn't know fails without touching anything", async () => {
    expect(await makeDeployer().deploy("gitlab", REPO)).toMatchObject({ outcome: "failed", error: `achq doesn't know the code host "gitlab"` });
    expect(router.mints).toEqual([]);
    expect(containerProvider.ops()).toEqual([]);
  });

  test("a push with the same .achq tree is a no-op", async () => {
    github.commit(REPO, repoFiles());
    const deployer = makeDeployer();
    await deployer.handle(event("installation.created", [REPO]));
    const status = github.variable(REPO, STATUS_VARIABLE);
    const before = { ops: containerProvider.ops().length, puts: router.count("PUT", "/admin/repos"), evaluations, validations: router.validations.length };

    github.commit(REPO, repoFiles({ "README.md": "# changed outside .achq" }));
    expect(await deployer.deploy("github", REPO)).toMatchObject({ outcome: "unchanged" });
    await deployer.handle(event("push", [REPO]));

    expect({ ops: containerProvider.ops().length, puts: router.count("PUT", "/admin/repos"), evaluations, validations: router.validations.length }).toEqual(before);
    expect(github.variable(REPO, STATUS_VARIABLE)).toEqual(status);
    // Only reads of the tree happened: no blob downloads, no variable writes.
    const late = github.requests.slice(github.requests.findLastIndex((r) => r.path.includes("/actions/variables")) + 1);
    expect(late.filter((r) => r.path.includes("/git/blobs/") || r.method !== "GET")).toEqual([]);
  });

  test("changing only a prompt re-pushes router config with the new commit, without a rebuild", async () => {
    github.commit(REPO, repoFiles());
    const deployer = makeDeployer();
    await deployer.deploy("github", REPO);
    const commit = github.commit(REPO, repoFiles({ ".achq/prompts/system.md": "You are a careful coder." }));
    expect((await deployer.deploy("github", REPO)).outcome).toBe("deployed");
    expect(router.repos.get(REPO)!.commit).toBe(commit);
    expect(containerProvider.ops("deploy")).toHaveLength(1);
    expect(containerProvider.services.get(`${REPO}/dev`)!.builds).toBe(1);
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "deployed", commit });
  });

  test("changing the Dockerfile, or the image path, rebuilds", async () => {
    github.commit(REPO, repoFiles());
    const deployer = makeDeployer();
    await deployer.deploy("github", REPO);
    github.commit(REPO, repoFiles({ ".achq/Dockerfile": "FROM oven/bun:1.4\n" }));
    await deployer.deploy("github", REPO);
    expect(containerProvider.ops("deploy")).toHaveLength(2);

    const moved = DOC_CONFIG["config.ts"].replace(`image: "./Dockerfile"`, `image: "./images/dev.Dockerfile"`);
    github.commit(REPO, repoFiles({ ".achq/config.ts": moved, ".achq/images/dev.Dockerfile": "FROM oven/bun:1.4\n" }));
    await deployer.deploy("github", REPO);
    expect(containerProvider.ops("deploy")).toHaveLength(3);
    expect(containerProvider.services.get(`${REPO}/dev`)!.spec.dockerfile).toBe(".achq/images/dev.Dockerfile");
  });

  test("a new container is built; a removed one is left alone", async () => {
    github.commit(REPO, repoFiles());
    const deployer = makeDeployer();
    await deployer.deploy("github", REPO);
    const two = `${DOC_CONFIG["config.ts"]}\nnew Container("ci", { image: "./Dockerfile" });`;
    github.commit(REPO, repoFiles({ ".achq/config.ts": two }));
    await deployer.deploy("github", REPO);
    expect(containerProvider.ops("deploy").map((c) => c.name)).toEqual(["dev", "ci"]);

    github.commit(REPO, repoFiles());
    await deployer.deploy("github", REPO);
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(containerProvider.services.has(`${REPO}/ci`)).toBe(true);
    expect(router.repos.get(REPO)!.containers.map((c) => c.name)).toEqual(["dev"]);
  });

  test("a failed deploy after a good one keeps the good one's builds, and the same tree is retried", async () => {
    github.commit(REPO, repoFiles());
    const deployer = makeDeployer();
    await deployer.deploy("github", REPO);
    router.problems = () => ["temporarily refused"];
    const commit = github.commit(REPO, repoFiles({ ".achq/prompts/system.md": "v2" }));
    expect((await deployer.deploy("github", REPO)).outcome).toBe("failed");
    expect(router.repos.get(REPO)!.commit).not.toBe(commit);
    router.problems = () => [];
    expect((await deployer.deploy("github", REPO)).outcome).toBe("deployed");
    expect(router.repos.get(REPO)!.commit).toBe(commit);
    expect(containerProvider.ops("deploy")).toHaveLength(1);
  });
});

test("a container provider's failure only you can fix, in your browser, goes in ACHQ_STATUS with what to open; the next deploy that works clears it", async () => {
  github.commit(REPO, repoFiles());
  const action = { url: "https://github.com/apps/vendor/installations/new", what: `install vendor on ${REPO}` };
  const ensure = containerProvider.ensure.bind(containerProvider);
  containerProvider.ensure = async () => {
    throw new BrowserActionNeeded("the vendor's App can't see the repo", action);
  };
  const deployer = makeDeployer();
  expect((await deployer.deploy("github", REPO)).outcome).toBe("failed");
  expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "failed", error: "the vendor's App can't see the repo", action });

  containerProvider.ensure = ensure;
  expect((await deployer.deploy("github", REPO)).outcome).toBe("deployed");
  expect(github.variable(REPO, STATUS_VARIABLE).action).toBeUndefined();
});

describe("uninstall", () => {
  test("removes the router config and keeps containers; reinstalling brings it back without a rebuild", async () => {
    github.commit(REPO, repoFiles());
    const deployer = makeDeployer();
    await deployer.handle(event("installation.created", [REPO]));
    await deployer.handle(event("installation_repositories.removed", [REPO]));
    expect(router.repos.has(REPO)).toBe(false);
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(containerProvider.services.has(`${REPO}/dev`)).toBe(true);
    expect((await deployer.status())[0]).toMatchObject({ repo: REPO, state: "uninstalled" });

    await deployer.handle(event("installation_repositories.added", [REPO]));
    expect(router.repos.get(REPO)).toBeDefined();
    expect(containerProvider.ops("deploy")).toHaveLength(1);
    expect((await deployer.status())[0]!.state).toBe("deployed");
  });

  test("installation.deleted uninstalls every listed repo", async () => {
    github.commit(REPO, repoFiles());
    github.commit("djgrant/notes", repoFiles());
    const deployer = makeDeployer();
    await deployer.handle(event("installation.created", [REPO, "djgrant/notes"]));
    expect(router.repos.size).toBe(2);
    await deployer.handle(event("installation.deleted", [REPO, "djgrant/notes"]));
    expect(router.repos.size).toBe(0);
    expect(containerProvider.ops("remove")).toEqual([]);
  });
});

describe("deliveries", () => {
  test("a duplicate delivery is handled once, concurrently, later, and after a restart", async () => {
    github.commit(REPO, repoFiles());
    const envelope = event("installation.created", [REPO]);
    const deployer = makeDeployer();
    const results = await Promise.all([deployer.handle(envelope), deployer.handle(envelope)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await deployer.handle(envelope)).toBe(false);
    expect(await makeDeployer().handle(envelope)).toBe(false);
    expect(router.mints).toHaveLength(1);
    expect(containerProvider.ops("ensure")).toHaveLength(1);
  });

  test("deploys of one repo don't overlap", async () => {
    github.commit(REPO, repoFiles());
    let active = 0;
    let most = 0;
    const deployer = createDeployer({
      containerProvider,
      router: routerClient({ url: router.url, key: KEY }),
      owners: ["notationlabs"],
      stores: dirStores(dataDir),
      ...githubDeps(),
      evaluate: async (files) => {
        most = Math.max(most, ++active);
        await Bun.sleep(20);
        try {
          return await evaluateConfig(files);
        } finally {
          active--;
        }
      },
      env: ENV,
      log: () => {},
    });
    // Without serialising, all three would see no record yet and evaluate at once.
    const outcomes = await Promise.all([deployer.deploy("github", REPO), deployer.deploy("github", REPO.toUpperCase()), deployer.deploy("github", REPO)]);
    expect(most).toBe(1);
    expect(outcomes.map((o) => o.outcome)).toEqual(["deployed", "unchanged", "unchanged"]);
    expect(containerProvider.ops("ensure")).toHaveLength(1);
  });
});

describe("sync", () => {
  const A = "notationlabs/alpha";
  const B = "notationlabs/beta";

  test("deploys installed repos, uninstalls the rest, and with prune removes exactly the right containers", async () => {
    github.commit(A, repoFiles());
    github.commit(B, repoFiles());
    router.installed = [
      { host: "github", repo: A },
      { host: "github", repo: B },
    ];
    const deployer = makeDeployer();
    expect(await deployer.sync()).toEqual({ deployed: [A, B], unchanged: [], uninstalled: [], pruned: [], failed: [] });

    // B is uninstalled. A keeps its plan but has a leftover container. notationlabs/gone was never recorded.
    router.installed = [{ host: "github", repo: A }];
    containerProvider.seed(A, "old");
    containerProvider.seed("notationlabs/gone", "dev");
    router.installed.push({ host: "github", repo: "notationlabs/fresh" });
    containerProvider.seed("notationlabs/fresh", "dev"); // installed but never deployed: no known plan, so kept

    const dry = await deployer.sync({ prune: true, dryRun: true });
    dry.pruned.sort();
    expect(dry).toEqual({
      deployed: [],
      unchanged: [A],
      uninstalled: [B],
      pruned: [`${A}/old`, `${B}/dev`, "notationlabs/gone/dev"],
      failed: [{ repo: "notationlabs/fresh", error: expect.stringContaining("Not Found") }],
    });
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(router.repos.has(B.toLowerCase())).toBe(true);

    const result = await deployer.sync({ prune: true });
    expect(result.pruned.sort()).toEqual(dry.pruned);
    expect(result.uninstalled).toEqual([B]);
    expect(containerProvider.ops("remove").map((c) => `${c.repo}/${c.name}`).sort()).toEqual(dry.pruned);
    expect([...containerProvider.services.keys()].sort()).toEqual([`${A}/dev`, "notationlabs/fresh/dev"]);
    expect(router.repos.has(B.toLowerCase())).toBe(false);

    expect(await deployer.sync({ prune: true })).toMatchObject({ deployed: [], unchanged: [A], uninstalled: [], pruned: [] });
  });

  test("empty syncs to no repos: it uninstalls each, deleting its ACHQ_STATUS, and with prune deletes every container; expected containers fail it before it changes anything", async () => {
    github.commit(A, repoFiles());
    router.installed = [{ host: "github", repo: A }];
    const deployer = makeDeployer();
    await deployer.sync();
    containerProvider.seed("notationlabs/gone", "dev");
    const all = [`${A}/dev`, "notationlabs/gone/dev"];

    const dry = await deployer.sync({ empty: true, prune: true, dryRun: true });
    expect({ ...dry, pruned: dry.pruned.sort() }).toEqual({ deployed: [], unchanged: [], uninstalled: [A], pruned: all, failed: [] });
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(github.variable(A, STATUS_VARIABLE)).toBeDefined();

    await expect(deployer.sync({ empty: true, prune: true, expect: [`${A}/dev`] })).rejects.toThrow("notationlabs/gone/dev");
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(router.repos.has(A.toLowerCase())).toBe(true);

    expect((await deployer.sync({ empty: true, prune: true, expect: all })).pruned.sort()).toEqual(all);
    expect(containerProvider.services.size).toBe(0);
    expect(router.repos.size).toBe(0);
    expect(github.variable(A, STATUS_VARIABLE)).toBeUndefined();
    expect(await deployer.sync({ empty: true, prune: true, expect: all })).toEqual({ deployed: [], unchanged: [], uninstalled: [], pruned: [], failed: [] });
  });

  test("without prune, sync never removes containers", async () => {
    github.commit(A, repoFiles());
    router.installed = [{ host: "github", repo: A }];
    const deployer = makeDeployer();
    await deployer.sync();
    router.installed = [];
    expect(await deployer.sync()).toMatchObject({ uninstalled: [A], pruned: [] });
    expect(containerProvider.ops("remove")).toEqual([]);
  });

  test("a dry run changes nothing", async () => {
    github.commit(A, repoFiles());
    router.installed = [{ host: "github", repo: A }];
    const deployer = makeDeployer();
    expect(await deployer.sync({ dryRun: true })).toMatchObject({ deployed: [A] });
    expect(containerProvider.ops()).toEqual([]);
    expect(router.repos.size).toBe(0);
    expect(github.variable(A, STATUS_VARIABLE)).toBeUndefined();
    expect(await deployer.status()).toEqual([]);
  });
});

describe("HTTP", () => {
  test("the deployer's endpoints need an admin signature, and the router client signs its requests", async () => {
    github.commit(REPO, repoFiles());
    const deployer = makeDeployer();
    const server = Bun.serve({ port: 0, fetch: deployerHandler(deployer, KEY, () => {}) });
    const base = `http://localhost:${server.port}`;
    try {
      const body = JSON.stringify(event("installation.created", [REPO]));
      expect((await fetch(`${base}/events`, { method: "POST", body })).status).toBe(401);
      expect((await signedFetch(adminSecret("wrong"), `${base}/events`, { method: "POST", body })).status).toBe(401);
      expect((await signedFetch(adminSecret(KEY), `${base}/events`, { method: "POST", body })).status).toBe(202);
      expect(github.variable(REPO, STATUS_VARIABLE).state).toBe("deployed");

      const status = await signedFetch(adminSecret(KEY), `${base}/status`, { method: "GET" });
      expect(((await status.json()) as { state: string }[])[0]!.state).toBe("deployed");
      const sync = await signedFetch(adminSecret(KEY), `${base}/sync`, { method: "POST", body: JSON.stringify({ dryRun: true }) });
      expect(sync.status).toBe(202);
      const { id } = (await sync.json()) as { id: string };
      const syncStatus = () => signedFetch(adminSecret(KEY), `${base}/sync/${id}`, { method: "GET" }).then((r) => r.json() as Promise<{ state: string }>);
      while ((await syncStatus()).state === "running") await Bun.sleep(5);
      expect(await syncStatus()).toMatchObject({ state: "done", result: { unchanged: [REPO] } });
      expect((await signedFetch(adminSecret(KEY), `${base}/sync/nope`, { method: "GET" })).status).toBe(404);
      expect((await fetch(`${base}/`)).status).toBe(200);
    } finally {
      server.stop(true);
    }

    // The fake router refuses anything not signed with the admin secret.
    await expect(routerClient({ url: router.url, key: "wrong" }).installed()).rejects.toThrow("401");
    expect(router.rejected).toBe(1);
  });
});

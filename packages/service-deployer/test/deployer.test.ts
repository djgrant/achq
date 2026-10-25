import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { deployerClient } from "@achq/core/clients/deployer";
import { routerAdmin } from "@achq/core/clients/router";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserActionNeeded, type DeployerEnvelope } from "@achq/core";
import { STATUS_VARIABLE } from "@achq/github";
import { adminSecret, containerSecret } from "@achq/core/secrets";
import { signedFetcher } from "@achq/core/signing";
import { HttpError } from "@achq/utils/http";
import { evaluateConfig } from "../src/features/config/evaluate.ts";
import { DOC_CONFIG, DOC_PLAN } from "@achq/test-utils/fixtures/config";
import { createContext } from "../src/context.ts";
import { deploy, status } from "../src/features/deploy.ts";
import { handleEvent } from "../src/features/events.ts";
import { sync } from "../src/features/sync.ts";
import { githubChannelProvider } from "@achq/github/channel";
import { githubCodeHostProvider } from "@achq/github/code-host";
import { FakeGitHub } from "@achq/test-utils/fakes/vendors/github";
import { FakeRouter } from "@achq/test-utils/fakes/achq/router";
import { MemoryContainerProvider } from "@achq/test-utils/fakes/achq/container-provider";
import { dirStores } from "@achq/test-utils/helpers/stores";
import { routes } from "../src/routes.ts";

const KEY = "test-webhook-key";
const REPO = "notationlabs/yieldstar";
const APP = "notation-achq";
const ENV = { containerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "claude-token" }, key: KEY, routerUrl: "http://router.internal:8081", routerPublicUrl: "https://router.example", ref: "abc123" };

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
  return { codeHost: githubCodeHostProvider.create(env) };
};

let github: FakeGitHub;
let router: FakeRouter;
let containerProvider: MemoryContainerProvider;
let dataDir: string;
let evaluations: number;
let clock: number;
let logs: string[];

const makeDeployer = (options: { owners?: string[]; env?: typeof ENV } = {}) =>
  createContext({ ...(options.env ?? ENV), owners: options.owners ?? ["NotationLabs", "djgrant"] }, {
    containerProvider,
    router: routerAdmin({ url: router.url, key: KEY }),
    stores: dirStores(dataDir),
    ...githubDeps(),
    evaluate: (files) => {
      evaluations++;
      return evaluateConfig(files);
    },
    now: () => new Date(Date.UTC(2026, 9, 17, 10, 0, clock++)),
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
  if (parsed?.to !== "deployer") throw new Error(`the GitHub channel ignored ${type}, or didn't make it a repo event`);
  return { event: parsed.event };
};

beforeEach(() => {
  github = new FakeGitHub().start();
  router = new FakeRouter(KEY, github);
  router.sources = [{ channel: "github", source: APP, events: ["issue_comment", "issues", "push", "installation"], permissions: { contents: "write", actions_variables: "write" } }];
  router.installed = [{ repo: REPO }];
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
    const deployer = await makeDeployer();
    expect(await handleEvent(deployer, event("installation.created", [REPO]))).toBe(true);

    expect(router.mints).toEqual([{ repo: REPO, policies: [{ provider: "github", repo: REPO, permissions: { ...DEPLOYER_PERMISSIONS } }] }]);

    expect(containerProvider.ops()).toEqual([
      { op: "ensure", repo: REPO, name: "dev" },
      { op: "build", repo: REPO, name: "dev" },
    ]);
    expect(containerProvider.services.get(`${REPO}/dev`)!.spec).toEqual({
      repo: REPO,
      // Read with the minted token, for a provider whose builds connect to the repo.
      identity: { id: "1000", name: REPO.split("/")[1], owner: { id: "500", name: REPO.split("/")[0] } },
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
      },
    });

    const declared = DOC_PLAN.policies[0]!.policy;
    expect(router.validations).toEqual([{ repo: REPO, policies: [declared] }]);
    expect(router.repos.get(REPO)).toEqual({
      repo: REPO,
      commit,
      containers: [{ name: "dev", url: "http://dev.notationlabs-yieldstar.internal:3000", policies: [declared] }],
      workspaces: DOC_PLAN.workspaces,
      triggers: DOC_PLAN.triggers.map(({ name, event }) => ({ name, event })),
    } as never);

    expect(github.variable(REPO, STATUS_VARIABLE)).toEqual({
      repo: REPO,
      state: "deployed",
      at: "2026-10-17T10:00:00.000Z",
      commit,
      containers: [{ name: "dev", location: { containerProvider: "memory", service: `${REPO}/dev` } }],
      router: "https://router.example",
    });
    const { router: _router, ...record } = github.variable(REPO, STATUS_VARIABLE);
    expect(await status(deployer)).toEqual([record]);
  });

  test("installing on several repos deploys each, each with its own ACHQ_STATUS", async () => {
    const other = "djgrant/notes";
    github.commit(REPO, repoFiles());
    github.commit(other, repoFiles({ ".achq/config.ts": `throw new Error("broken");` }));
    await handleEvent(await makeDeployer(), event("installation_repositories.added", [REPO, other]));
    expect(github.variable(REPO, STATUS_VARIABLE).state).toBe("deployed");
    expect(github.variable(other, STATUS_VARIABLE)).toMatchObject({ state: "failed", error: ".achq/config.ts: The config threw: Error: broken" });
    expect(router.mints.map((m) => m.repo)).toEqual([REPO, other]);
  });

  test("a disallowed owner is recorded as failed and its config is never fetched or evaluated", async () => {
    github.commit("stranger/repo", repoFiles());
    const deployer = await makeDeployer();
    await handleEvent(deployer, event("installation.created", ["stranger/repo"]));
    expect(evaluations).toBe(0);
    expect(router.mints).toEqual([]);
    expect(github.requests).toEqual([]);
    expect(containerProvider.ops()).toEqual([]);
    expect(router.count("PUT", "/admin/repos")).toBe(0);
    expect(await status(deployer)).toEqual([{ repo: "stranger/repo", state: "failed", at: expect.any(String), error: "stranger isn't an owner this deployer serves" }]);
  });

  test("owners match case-insensitively", async () => {
    github.commit(REPO, repoFiles());
    const outcome = await deploy(await makeDeployer({ owners: ["NOTATIONLABS"] }), REPO);
    expect(outcome.outcome).toBe("deployed");
  });

  test("a config that fails in the sandbox is reported in ACHQ_STATUS and deploys nothing", async () => {
    github.commit(REPO, repoFiles({ ".achq/config.ts": `import { Container } from "achq"; while (true) {}` }));
    const deployer = await createContext({ ...ENV, owners: ["notationlabs"] }, {
      containerProvider,
      router: routerAdmin({ url: router.url, key: KEY }),
      stores: dirStores(dataDir),
      ...githubDeps(),
      evaluate: (files) => evaluateConfig(files, { timeoutMs: 200 }),
      log: () => {},
    });
    expect((await deploy(deployer, REPO)).outcome).toBe("failed");
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "failed", error: ".achq/config.ts: The config ran for longer than 200ms and was stopped" });
    expect(containerProvider.ops()).toEqual([]);
    expect(router.repos.size).toBe(0);

    github.commit(REPO, repoFiles({ ".achq/config.ts": `import "node:fs";` }));
    await deploy(deployer, REPO);
    expect(github.variable(REPO, STATUS_VARIABLE).error).toContain(`imports "node:fs"`);
  });

  test("a repo with no .achq/config.ts fails clearly", async () => {
    github.commit(REPO, { "README.md": "hi" });
    expect(await deploy(await makeDeployer(), REPO)).toMatchObject({ outcome: "failed", error: "there's no .achq/config.ts on main" });
    expect(evaluations).toBe(0);
    expect(github.variable(REPO, STATUS_VARIABLE).state).toBe("failed");
  });

  test(".achq/ over the size or file limits fails before evaluating", async () => {
    github.commit(REPO, repoFiles({ ".achq/big.ts": `export const s = "${"x".repeat(2 * 1024 * 1024)}";` }));
    expect((await deploy(await makeDeployer(), REPO)).error).toContain("the limit is 1048576");
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`.achq/lib/f${i}.ts`, "export {};"]));
    github.commit(REPO, repoFiles(many));
    expect((await deploy(await makeDeployer(), REPO)).error).toContain("source files; the limit is 200");
    expect(evaluations).toBe(0);
  });
});

describe("checks", () => {
  test("a validation failure from the router stops the deploy", async () => {
    router.problems = (policy) => (policy.permissions && (policy.permissions as Record<string, string>).pull_requests ? [`${APP} doesn't have pull_requests: write`] : []);
    github.commit(REPO, repoFiles());
    expect(await deploy(await makeDeployer(), REPO)).toMatchObject({ outcome: "failed", error: `${APP} doesn't have pull_requests: write` });
    expect(containerProvider.ops()).toEqual([]);
    expect(router.count("PUT", "/admin/repos")).toBe(0);
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "failed", error: `${APP} doesn't have pull_requests: write` });
  });

  test("a trigger wanting an event the App doesn't send stops the deploy", async () => {
    router.sources[0]!.events = ["issues"];
    github.commit(REPO, repoFiles());
    expect((await deploy(await makeDeployer(), REPO)).error).toBe(`trigger mention wants issue_comment, which ${APP} doesn't send`);
    expect(containerProvider.ops()).toEqual([]);
  });

  test("config that names an App the router doesn't know fails", async () => {
    github.commit(REPO, repoFiles({ ".achq/config.ts": DOC_CONFIG["config.ts"].replace(`Channel.get("notation-achq")`, `Channel.get("ghost")`) }));
    const { error } = await deploy(await makeDeployer(), REPO);
    expect(error).toContain("policy code names ghost, which the router doesn't know");
    expect(error).toContain("workspace docs names github:ghost, which the router doesn't know");
    expect(containerProvider.ops()).toEqual([]);
  });

  test("a missing Dockerfile fails; a trigger no workspace covers is a warning", async () => {
    github.commit(REPO, repoFiles({ ".achq/Dockerfile": undefined }));
    expect((await deploy(await makeDeployer(), REPO)).error).toBe("container dev's image .achq/Dockerfile doesn't exist");

    router.sources.push({ channel: "github", source: "second", events: ["issues"], permissions: {} });
    const config = `${DOC_CONFIG["config.ts"]}\nnew Trigger("lonely", { event: github.Channel.get("second").issue(), agent: triage });`;
    github.commit(REPO, repoFiles({ ".achq/config.ts": config }));
    const outcome = await deploy(await makeDeployer(), REPO);
    expect(outcome).toMatchObject({ outcome: "deployed", warnings: ["trigger lonely never runs: no workspace's threads come from github:second"] });
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "deployed", warnings: outcome.warnings });
  });

  // Goes with oldRunnerWarnings.
  test("a Dockerfile that still names achq-agent is a warning, not a comment that does", async () => {
    const warning = "container dev's .achq/Dockerfile names achq-agent, which is achq-runner now: its container provider starts the runner, so a CMD naming it is ignored and can go";
    github.commit(REPO, repoFiles({ ".achq/Dockerfile": 'FROM oven/bun:1\nCMD ["achq-agent"]\n' }));
    const outcome = await deploy(await makeDeployer(), REPO);
    expect(outcome).toMatchObject({ outcome: "deployed", warnings: [warning] });
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "deployed", warnings: [warning] });

    github.commit(REPO, repoFiles({ ".achq/Dockerfile": "FROM oven/bun:1\n# was CMD achq-agent\nRUN echo achq-agents\n" }));
    expect((await deploy(await makeDeployer(), REPO)).warnings).toBeUndefined();
  });
});

describe("config changes", () => {
  // Delete with the records migration in src/store.ts.
  test("records kept under their old file names move to their repo keys when the deployer starts", async () => {
    github.commit(REPO, repoFiles());
    expect((await deploy(await makeDeployer(), REPO)).outcome).toBe("deployed");
    // As an older deployer kept them: `owner__name`, and a name that's no repo's made safe as a file name.
    const records = dirStores(dataDir)("records");
    await records.write("notationlabs__yieldstar", (await records.read(REPO))!);
    await records.remove(REPO);
    await records.write("_hidden", { repo: ".Hidden", state: "failed", at: "2026-10-17T10:00:00Z", error: "no such repo" });

    const deployer = await makeDeployer();
    expect(await records.list()).toEqual([".hidden", REPO]);
    expect((await deploy(deployer, REPO)).outcome).toBe("unchanged");
  });

  test("a repo whose record is unreadable deploys as if it had none, logged, and the deploy rewrites the record", async () => {
    github.commit(REPO, repoFiles());
    expect((await deploy(await makeDeployer(), REPO)).outcome).toBe("deployed");
    const records = dirStores(dataDir)("records");
    await records.write(REPO, { repo: REPO, state: "deployed", at: 7 });

    expect((await deploy(await makeDeployer(), REPO)).outcome).toBe("deployed");
    expect(logs).toContain(`store: records "${REPO}" isn't readable, so it's treated as absent: at: Invalid input: expected string, received number`);
    expect(await records.read(REPO)).toMatchObject({ repo: REPO, state: "deployed", at: expect.any(String) });
  });

  test("a new token for the agents deploys again, with the same .achq tree, and builds nothing", async () => {
    github.commit(REPO, repoFiles());
    expect((await deploy(await makeDeployer(), REPO)).outcome).toBe("deployed");
    const builds = containerProvider.ops().filter((o) => o.op === "build").length;
    const renewed = { ...ENV, containerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "new-token" } };
    expect((await deploy(await makeDeployer({ env: renewed }), REPO)).outcome).toBe("deployed");
    expect(containerProvider.services.get(`${REPO}/dev`)!.spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("new-token");
    expect(containerProvider.ops().filter((o) => o.op === "build").length).toBe(builds);
    expect((await deploy(await makeDeployer({ env: renewed }), REPO)).outcome).toBe("unchanged");
  });

  test("a name the code host has no repo by fails without touching anything", async () => {
    expect(await deploy(await makeDeployer(), "notationlabs/a/b")).toMatchObject({ outcome: "failed", error: `"notationlabs/a/b" isn't a repository name` });
    expect(router.mints).toEqual([]);
    expect(containerProvider.ops()).toEqual([]);
  });

  test("a push with the same .achq tree is a no-op", async () => {
    github.commit(REPO, repoFiles());
    const deployer = await makeDeployer();
    await handleEvent(deployer, event("installation.created", [REPO]));
    const status = github.variable(REPO, STATUS_VARIABLE);
    const before = { ops: containerProvider.ops().length, puts: router.count("PUT", "/admin/repos"), evaluations, validations: router.validations.length };

    github.commit(REPO, repoFiles({ "README.md": "# changed outside .achq" }));
    expect(await deploy(deployer, REPO)).toMatchObject({ outcome: "unchanged" });
    await handleEvent(deployer, event("push", [REPO]));

    expect({ ops: containerProvider.ops().length, puts: router.count("PUT", "/admin/repos"), evaluations, validations: router.validations.length }).toEqual(before);
    expect(github.variable(REPO, STATUS_VARIABLE)).toEqual(status);
    // Only reads of the tree happened: no blob downloads, no variable writes.
    const late = github.requests.slice(github.requests.findLastIndex((r) => r.path.includes("/actions/variables")) + 1);
    expect(late.filter((r) => r.path.includes("/git/blobs/") || r.method !== "GET")).toEqual([]);
  });

  test("changing only a prompt re-pushes router config with the new commit, without a rebuild", async () => {
    github.commit(REPO, repoFiles());
    const deployer = await makeDeployer();
    await deploy(deployer, REPO);
    const commit = github.commit(REPO, repoFiles({ ".achq/prompts/system.md": "You are a careful coder." }));
    expect((await deploy(deployer, REPO)).outcome).toBe("deployed");
    expect(router.repos.get(REPO)!.commit).toBe(commit);
    expect(containerProvider.ops("build")).toHaveLength(1);
    expect(containerProvider.services.get(`${REPO}/dev`)!.builds).toBe(1);
    expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "deployed", commit });
  });

  test("changing the Dockerfile, or the image path, rebuilds", async () => {
    github.commit(REPO, repoFiles());
    const deployer = await makeDeployer();
    await deploy(deployer, REPO);
    github.commit(REPO, repoFiles({ ".achq/Dockerfile": "FROM oven/bun:1.4\n" }));
    await deploy(deployer, REPO);
    expect(containerProvider.ops("build")).toHaveLength(2);

    const moved = DOC_CONFIG["config.ts"].replace(`image: "./Dockerfile"`, `image: "./images/dev.Dockerfile"`);
    github.commit(REPO, repoFiles({ ".achq/config.ts": moved, ".achq/images/dev.Dockerfile": "FROM oven/bun:1.4\n" }));
    await deploy(deployer, REPO);
    expect(containerProvider.ops("build")).toHaveLength(3);
    expect(containerProvider.services.get(`${REPO}/dev`)!.spec.dockerfile).toBe(".achq/images/dev.Dockerfile");
  });

  test("a new container is built; a removed one is left alone", async () => {
    github.commit(REPO, repoFiles());
    const deployer = await makeDeployer();
    await deploy(deployer, REPO);
    const two = `${DOC_CONFIG["config.ts"]}\nnew Container("ci", { image: "./Dockerfile" });`;
    github.commit(REPO, repoFiles({ ".achq/config.ts": two }));
    await deploy(deployer, REPO);
    expect(containerProvider.ops("build").map((c) => c.name)).toEqual(["dev", "ci"]);

    github.commit(REPO, repoFiles());
    await deploy(deployer, REPO);
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(containerProvider.services.has(`${REPO}/ci`)).toBe(true);
    expect(router.repos.get(REPO)!.containers.map((c) => c.name)).toEqual(["dev"]);
  });

  test("a failed deploy after a good one keeps the good one's builds, and the same tree is retried", async () => {
    github.commit(REPO, repoFiles());
    const deployer = await makeDeployer();
    await deploy(deployer, REPO);
    router.problems = () => ["temporarily refused"];
    const commit = github.commit(REPO, repoFiles({ ".achq/prompts/system.md": "v2" }));
    expect((await deploy(deployer, REPO)).outcome).toBe("failed");
    expect(router.repos.get(REPO)!.commit).not.toBe(commit);
    router.problems = () => [];
    expect((await deploy(deployer, REPO)).outcome).toBe("deployed");
    expect(router.repos.get(REPO)!.commit).toBe(commit);
    expect(containerProvider.ops("build")).toHaveLength(1);
  });
});

test("a container provider's failure only you can fix, in your browser, goes in ACHQ_STATUS with what to open; the next deploy that works clears it", async () => {
  github.commit(REPO, repoFiles());
  const action = { url: "https://github.com/apps/vendor/installations/new", what: `install vendor on ${REPO}` };
  const ensure = containerProvider.ensure.bind(containerProvider);
  containerProvider.ensure = async () => {
    throw new BrowserActionNeeded("the vendor's App can't see the repo", action);
  };
  const deployer = await makeDeployer();
  expect((await deploy(deployer, REPO)).outcome).toBe("failed");
  expect(github.variable(REPO, STATUS_VARIABLE)).toMatchObject({ state: "failed", error: "the vendor's App can't see the repo", action });

  containerProvider.ensure = ensure;
  expect((await deploy(deployer, REPO)).outcome).toBe("deployed");
  expect(github.variable(REPO, STATUS_VARIABLE).action).toBeUndefined();
});

describe("uninstall", () => {
  test("removes the router config and keeps containers; reinstalling brings it back without a rebuild", async () => {
    github.commit(REPO, repoFiles());
    const deployer = await makeDeployer();
    await handleEvent(deployer, event("installation.created", [REPO]));
    await handleEvent(deployer, event("installation_repositories.removed", [REPO]));
    expect(router.repos.has(REPO)).toBe(false);
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(containerProvider.services.has(`${REPO}/dev`)).toBe(true);
    expect((await status(deployer))[0]).toMatchObject({ repo: REPO, state: "uninstalled" });

    await handleEvent(deployer, event("installation_repositories.added", [REPO]));
    expect(router.repos.get(REPO)).toBeDefined();
    expect(containerProvider.ops("build")).toHaveLength(1);
    expect((await status(deployer))[0]!.state).toBe("deployed");
  });

  test("installation.deleted uninstalls every listed repo", async () => {
    github.commit(REPO, repoFiles());
    github.commit("djgrant/notes", repoFiles());
    const deployer = await makeDeployer();
    await handleEvent(deployer, event("installation.created", [REPO, "djgrant/notes"]));
    expect(router.repos.size).toBe(2);
    await handleEvent(deployer, event("installation.deleted", [REPO, "djgrant/notes"]));
    expect(router.repos.size).toBe(0);
    expect(containerProvider.ops("remove")).toEqual([]);
  });
});

describe("deliveries", () => {
  test("a duplicate delivery is handled once, concurrently, later, and after a restart", async () => {
    github.commit(REPO, repoFiles());
    const envelope = event("installation.created", [REPO]);
    const deployer = await makeDeployer();
    const results = await Promise.all([handleEvent(deployer, envelope), handleEvent(deployer, envelope)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await handleEvent(deployer, envelope)).toBe(false);
    expect(await handleEvent(await makeDeployer(), envelope)).toBe(false);
    expect(router.mints).toHaveLength(1);
    expect(containerProvider.ops("ensure")).toHaveLength(1);
  });

  test("deploys of one repo don't overlap", async () => {
    github.commit(REPO, repoFiles());
    let active = 0;
    let most = 0;
    const deployer = await createContext({ ...ENV, owners: ["notationlabs"] }, {
      containerProvider,
      router: routerAdmin({ url: router.url, key: KEY }),
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
      log: () => {},
    });
    // Without serialising, all three would see no record yet and evaluate at once.
    const outcomes = await Promise.all([deploy(deployer, REPO), deploy(deployer, REPO.toUpperCase()), deploy(deployer, REPO)]);
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
      { repo: A },
      { repo: B },
    ];
    const deployer = await makeDeployer();
    expect(await sync(deployer)).toEqual({ deployed: [A, B], unchanged: [], uninstalled: [], pruned: [], failed: [] });

    // B is uninstalled. A keeps its plan but has a leftover container. notationlabs/gone was never recorded.
    router.installed = [{ repo: A }];
    containerProvider.seed(A, "old");
    containerProvider.seed("notationlabs/gone", "dev");
    router.installed.push({ repo: "notationlabs/fresh" });
    containerProvider.seed("notationlabs/fresh", "dev"); // installed but never deployed: no known plan, so kept

    const dry = await sync(deployer, { prune: true, dryRun: true });
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

    const result = await sync(deployer, { prune: true });
    expect(result.pruned.sort()).toEqual(dry.pruned);
    expect(result.uninstalled).toEqual([B]);
    expect(containerProvider.ops("remove").map((c) => `${c.repo}/${c.name}`).sort()).toEqual(dry.pruned);
    expect([...containerProvider.services.keys()].sort()).toEqual([`${A}/dev`, "notationlabs/fresh/dev"]);
    expect(router.repos.has(B.toLowerCase())).toBe(false);

    expect(await sync(deployer, { prune: true })).toMatchObject({ deployed: [], unchanged: [A], uninstalled: [], pruned: [] });
  });

  test("empty syncs to no repos: it uninstalls each, deleting its ACHQ_STATUS, and with prune deletes every container; expected containers fail it before it changes anything", async () => {
    github.commit(A, repoFiles());
    router.installed = [{ repo: A }];
    const deployer = await makeDeployer();
    await sync(deployer);
    containerProvider.seed("notationlabs/gone", "dev");
    const all = [`${A}/dev`, "notationlabs/gone/dev"];

    const dry = await sync(deployer, { empty: true, prune: true, dryRun: true });
    expect({ ...dry, pruned: dry.pruned.sort() }).toEqual({ deployed: [], unchanged: [], uninstalled: [A], pruned: all, failed: [] });
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(github.variable(A, STATUS_VARIABLE)).toBeDefined();

    await expect(sync(deployer, { empty: true, prune: true, expect: [`${A}/dev`] })).rejects.toThrow("notationlabs/gone/dev");
    expect(containerProvider.ops("remove")).toEqual([]);
    expect(router.repos.has(A.toLowerCase())).toBe(true);

    expect((await sync(deployer, { empty: true, prune: true, expect: all })).pruned.sort()).toEqual(all);
    expect(containerProvider.services.size).toBe(0);
    expect(router.repos.size).toBe(0);
    expect(github.variable(A, STATUS_VARIABLE)).toBeUndefined();
    expect(await sync(deployer, { empty: true, prune: true, expect: all })).toEqual({ deployed: [], unchanged: [], uninstalled: [], pruned: [], failed: [] });
  });

  test("without prune, sync never removes containers", async () => {
    github.commit(A, repoFiles());
    router.installed = [{ repo: A }];
    const deployer = await makeDeployer();
    await sync(deployer);
    router.installed = [];
    expect(await sync(deployer)).toMatchObject({ uninstalled: [A], pruned: [] });
    expect(containerProvider.ops("remove")).toEqual([]);
  });

  test("a dry run changes nothing", async () => {
    github.commit(A, repoFiles());
    router.installed = [{ repo: A }];
    const deployer = await makeDeployer();
    expect(await sync(deployer, { dryRun: true })).toMatchObject({ deployed: [A] });
    expect(containerProvider.ops()).toEqual([]);
    expect(router.repos.size).toBe(0);
    expect(github.variable(A, STATUS_VARIABLE)).toBeUndefined();
    expect(await status(deployer)).toEqual([]);
  });
});

describe("HTTP", () => {
  test("the deployer's endpoints need an admin signature, and the router client signs its requests", async () => {
    github.commit(REPO, repoFiles());
    const deployer = await makeDeployer();
    const server = Bun.serve({ port: 0, fetch: routes(deployer).fetch });
    const base = `http://localhost:${server.port}`;
    try {
      const body = JSON.stringify(event("installation.created", [REPO]));
      expect((await fetch(`${base}/events`, { method: "POST", body })).status).toBe(401);
      expect((await signedFetcher(adminSecret("wrong"), base)("/events", { method: "POST", body })).status).toBe(401);
      const client = deployerClient(signedFetcher(adminSecret(KEY), base));
      expect(await client.events({ body: event("installation.created", [REPO]) })).toBeUndefined();
      expect(github.variable(REPO, STATUS_VARIABLE).state).toBe("deployed");

      expect((await client.status())[0]!.state).toBe("deployed");
      const { id } = await client.sync({ body: { dryRun: true } });
      const syncStatus = () => client.syncStatus({ params: { id } });
      while ((await syncStatus()).state === "running") await Bun.sleep(5);
      expect(await syncStatus()).toMatchObject({ state: "done", result: { unchanged: [REPO] } });
      const unknown = await client.syncStatus({ params: { id: "nope" } }).catch((e: unknown) => e);
      expect(unknown).toBeInstanceOf(HttpError);
      expect((unknown as HttpError).message).toBe("Deployer GET /sync/nope: 404 no such sync");
      expect((await fetch(`${base}/`)).status).toBe(200);
    } finally {
      server.stop(true);
    }

    // The fake router refuses anything not signed with the admin secret.
    await expect(routerAdmin({ url: router.url, key: "wrong" }).installed()).rejects.toThrow("401");
    expect(router.rejected).toBe(1);
  });

  test("a sync's status survives the deployer restarting, and one it was running reads as interrupted", async () => {
    github.commit(REPO, repoFiles());
    router.installed = [{ repo: REPO }];
    const serve = async () => Bun.serve({ port: 0, fetch: routes(await makeDeployer()).fetch });
    const client = (base: string) => deployerClient(signedFetcher(adminSecret(KEY), base));

    const before = await serve();
    const base = `http://localhost:${before.port}`;
    const { id } = await client(base).sync({ body: {} });
    while ((await client(base).syncStatus({ params: { id } })).state === "running") await Bun.sleep(5);
    before.stop(true);

    // A sync the old deployer was running when it stopped: its heartbeat long since written.
    const stale = new Date(Date.now() - 60_000).toISOString();
    await dirStores(dataDir)("syncs").write("lost", { id: "lost", state: "running", started: stale, heartbeat: stale });

    const after = await serve();
    const again = `http://localhost:${after.port}`;
    try {
      expect(await client(again).syncStatus({ params: { id } })).toMatchObject({ state: "done", result: { deployed: [REPO] } });
      expect(await client(again).syncStatus({ params: { id: "lost" } })).toEqual({ state: "interrupted" });
      await expect(client(again).syncStatus({ params: { id: "nope" } })).rejects.toMatchObject({ status: 404 });
    } finally {
      after.stop(true);
    }
  });
});

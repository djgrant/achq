import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AccessCredential, AccessProvider, Channel } from "@achq/core";
import { FakeGitHub, makeApp } from "@achq/test-utils/github";
import { githubChannel } from "../src/channels/index.ts";
import type { RepoPolicyData } from "../src/index.ts";
import { parseApps } from "../src/lib/app-keys.ts";
import { appsFor } from "../src/lib/apps.ts";
import { githubAccess } from "../src/policies/index.ts";
import { githubEnv } from "./payloads.ts";

const appA = makeApp("notation-achq", "101", { issues: "write", contents: "write", pull_requests: "read", metadata: "read" }, ["issues", "issue_comment", "push"]);
const appB = makeApp("djgrant-claude", "202", { issues: "write", contents: "read", metadata: "read" }, ["issue_comment"]);
const gh = new FakeGitHub([appA, appB]);
/** The router's parts, from one env. */
let api: { access: AccessProvider; channel: Channel };

const policy = (permissions: Record<string, "read" | "write">, repo: string | null = null, source = "notation-achq"): RepoPolicyData => ({ access: "github", source, repo, permissions });

beforeAll(() => {
  gh.start();
  const env = githubEnv(gh.keys(), gh.url);
  api = { access: githubAccess.create(env), channel: githubChannel.create(env) };
  gh.installations.push(
    { id: 77, app: appA.slug, account: "notationlabs", permissions: appA.permissions, repos: ["notationlabs/yieldstar", "notationlabs/shared"] },
    { id: 88, app: appA.slug, account: "djgrant", permissions: { contents: "read", metadata: "read" }, repos: ["djgrant/notes"] },
    { id: 99, app: appB.slug, account: "djgrant", permissions: appB.permissions, repos: ["djgrant/site", "djgrant/notes"] },
    { id: 66, app: appB.slug, account: "frozen", permissions: appB.permissions, repos: ["frozen/x"], suspended: true },
  );
});
afterAll(() => gh.stop());

test("the channel and access provider made from one configuration share its Apps, and so one JWT cache", () => {
  const env = githubEnv(gh.keys(), gh.url);
  expect(appsFor({ ...env })).toBe(appsFor(env));
  expect(appsFor(githubEnv(gh.keys()))).not.toBe(appsFor(env));
  expect(appsFor(githubEnv({}, gh.url))).not.toBe(appsFor(env));
});

describe("validate", () => {
  test("a policy within an installation's permissions, on a repo it covers, is fine", async () => {
    expect(await api.access.validate(policy({ contents: "write", issues: "read" }), "notationlabs/yieldstar")).toEqual([]);
    // Another installation of the same App.
    expect(await api.access.validate(policy({ contents: "read" }, "djgrant/notes"), "notationlabs/yieldstar")).toEqual([]);
  });

  test("says what's wrong otherwise", async () => {
    const repo = "notationlabs/yieldstar";
    expect(await api.access.validate(policy({ contents: "read" }, null, "stranger-app"), repo)).toEqual([`GitHub App "stranger-app" isn't configured on the router`]);
    expect(await api.access.validate(policy({ contents: "read" }, "elsewhere/x"), repo)).toEqual(["notation-achq isn't installed on elsewhere/x"]);
    expect(await api.access.validate(policy({ pull_requests: "write", actions: "read" }), repo)).toEqual([
      "notation-achq has pull_requests: read on notationlabs; the policy wants pull_requests: write",
      "notation-achq has no actions permission on notationlabs; the policy wants actions: read",
    ]);
    expect(await api.access.validate(policy({ contents: "admin" as any }), repo)).toEqual([`Permission contents is "admin"; it must be "read" or "write"`]);
    expect(await api.access.validate(policy({ contents: "read" }, "frozen/x", "djgrant-claude"), repo)).toEqual(["djgrant-claude's installation on frozen is suspended"]);
    // Installed on the account, but not on this repo.
    const [problem] = await api.access.validate(policy({ contents: "read" }, "notationlabs/secret"), repo);
    expect(problem).toStartWith("notation-achq's installation on notationlabs doesn't cover notationlabs/secret");
  });

  test("authenticates as the App with a JWT the fake checks against its public key", async () => {
    const impostor = githubAccess.create(githubEnv({ "notation-achq": { id: "101", privateKey: appB.privateKey } }, gh.url));
    await expect(impostor.validate(policy({ contents: "read" }), "notationlabs/yieldstar")).rejects.toThrow(/401/);
  });
});

describe("mint", () => {
  test("one token per repo, with the highest permission its policies ask for, the config's own repo first", async () => {
    const before = gh.minted.length;
    const credentials = await api.access.mint(
      [
        policy({ contents: "read", issues: "write" }, "notationlabs/shared"),
        policy({ contents: "write", issues: "read" }),
        policy({ contents: "read" }, "djgrant/notes"),
        policy({ issues: "write" }, "djgrant/notes", "djgrant-claude"),
        { access: "linear", workspace: "notation" },
      ],
      "notationlabs/yieldstar",
    );
    const requests = gh.minted.slice(before).sort((a, b) => a.installation - b.installation || a.body.repositories[0]!.localeCompare(b.body.repositories[0]!));
    expect(requests).toEqual([
      // Shared stays read-only for contents, though yieldstar's token under the same installation has write.
      { installation: 77, body: { repositories: ["shared"], permissions: { contents: "read", issues: "write" } } },
      { installation: 77, body: { repositories: ["yieldstar"], permissions: { contents: "write", issues: "read" } } },
      { installation: 88, body: { repositories: ["notes"], permissions: { contents: "read" } } },
      { installation: 99, body: { repositories: ["notes"], permissions: { issues: "write" } } },
    ]);
    expect(credentials.map((c) => c.scope)).toEqual([
      { app: "notation-achq", installation: 77, repos: ["notationlabs/yieldstar"], permissions: { contents: "write", issues: "read" } },
      { app: "notation-achq", installation: 77, repos: ["notationlabs/shared"], permissions: { contents: "read", issues: "write" } },
      { app: "notation-achq", installation: 88, repos: ["djgrant/notes"], permissions: { contents: "read" } },
      { app: "djgrant-claude", installation: 99, repos: ["djgrant/notes"], permissions: { issues: "write" } },
    ]);
    // The tokens are real to the fake: each covers what its scope says.
    for (const c of credentials) expect(gh.tokens.get(c.value)!.repos).toEqual(c.scope.repos as string[]);
    expect(credentials.every((c) => c.access === "github" && c.expiresAt === "2026-10-18T13:00:00Z")).toBe(true);
  });

  test("fails when an App isn't installed on a policy's repo", async () => {
    await expect(api.access.mint([policy({ contents: "read" }, "elsewhere/x")], "notationlabs/yieldstar")).rejects.toThrow(/isn't installed on elsewhere\/x/);
  });
});

describe("installations and sources", () => {
  test("every repo of every unsuspended installation, per App", async () => {
    const all = await api.channel.installations();
    expect(all.sort((a, b) => (a.source + a.repo).localeCompare(b.source + b.repo))).toEqual([
      { channel: "github", source: "djgrant-claude", repo: "djgrant/notes", host: "github" },
      { channel: "github", source: "djgrant-claude", repo: "djgrant/site", host: "github" },
      { channel: "github", source: "notation-achq", repo: "djgrant/notes", host: "github" },
      { channel: "github", source: "notation-achq", repo: "notationlabs/shared", host: "github" },
      { channel: "github", source: "notation-achq", repo: "notationlabs/yieldstar", host: "github" },
    ]);
  });

  test("each App's events and permissions", async () => {
    expect(await api.channel.sources()).toEqual([
      { channel: "github", source: "notation-achq", events: ["issues", "issue_comment", "push"], permissions: appA.permissions },
      { channel: "github", source: "djgrant-claude", events: ["issue_comment"], permissions: appB.permissions },
    ]);
  });

  test("parseApps reads ACHQ_GITHUB_APPS", () => {
    expect(parseApps(JSON.stringify({ a: { id: 5, privateKey: "k" } }))).toEqual({ a: { id: "5", privateKey: "k" } });
    expect(parseApps(undefined)).toEqual({});
    expect(() => parseApps(JSON.stringify({ a: { id: 5 } }))).toThrow(/privateKey/);
  });
});

describe("install", () => {
  const container = { access: githubAccess.create({}) }; // no keys, no network
  const credential = (value: string, installation: number, repos: string[], app = "notation-achq"): AccessCredential => ({
    access: "github",
    value,
    expiresAt: "2026-10-18T13:00:00Z",
    scope: { app, installation, repos, permissions: {} },
  });
  let root: string;
  let home: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "achq-gh-"));
    home = path.join(root, "home");
    fs.mkdirSync(home);
    // The user's own global config, which install must not replace.
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Someone\n");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /** What git hands over for `url`, using only the env install returned. Isolated from this machine's git config. */
  const fill = async (env: Record<string, string>, url: string) => {
    const out = await $`printf 'url=%s\n\n' ${url} | git credential fill`
      .env({ PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env })
      .quiet()
      .nothrow();
    return Object.fromEntries(out.stdout.toString().trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  };

  test("each repo URL gets its own installation's token; the global config stays", async () => {
    const dir = path.join(root, "github");
    const { env } = await container.access.install(
      [credential("tok-77", 77, ["notationlabs/yieldstar", "notationlabs/shared"]), credential("tok-99", 99, ["djgrant/site"], "djgrant-claude")],
      dir,
    );
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(await fill(env, "https://github.com/notationlabs/yieldstar.git")).toMatchObject({ username: "x-access-token", password: "tok-77" });
    expect((await fill(env, "https://github.com/notationlabs/shared")).password).toBe("tok-77");
    expect((await fill(env, "https://github.com/djgrant/site.git")).password).toBe("tok-99");
    // A repo no credential covers gets nothing from us.
    expect((await fill(env, "https://github.com/djgrant/other.git")).password).toBeUndefined();
    const name = await $`git config user.name`.env({ PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...env }).quiet().text();
    expect(name.trim()).toBe("Someone");

    for (const f of ["notation-achq-77.token", "djgrant-claude-99-djgrant_site.token", "gh/hosts.yml", "gitconfig"]) {
      expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(path.join(dir, "gh/hosts.yml"), "utf8")).toBe("github.com:\n    oauth_token: tok-77\n    user: notation-achq[bot]\n    git_protocol: https\n");
    expect(env.GH_CONFIG_DIR).toBe(path.join(dir, "gh"));
  });

  test("refreshing replaces tokens in place, keeps the env, and drops tokens no longer used", async () => {
    const dir = path.join(root, "refresh");
    const first = await container.access.install([credential("old-77", 77, ["o/a"]), credential("old-88", 88, ["o/b"])], dir);
    expect((await fill(first.env, "https://github.com/o/a.git")).password).toBe("old-77");
    const second = await container.access.install([credential("new-77", 77, ["o/a"])], dir);
    expect(second.env).toEqual(first.env);
    expect((await fill(first.env, "https://github.com/o/a.git")).password).toBe("new-77");
    expect((await fill(first.env, "https://github.com/o/b.git")).password).toBeUndefined();
    expect(fs.readdirSync(dir).sort()).toEqual(["gh", "gitconfig", "notation-achq-77-o_a.token"]);
    expect(fs.readFileSync(path.join(dir, "gh/hosts.yml"), "utf8")).toContain("oauth_token: new-77");
  });

  test("a reader in another process during refreshes sees a whole token, the old or the new", async () => {
    const dir = path.join(root, "atomic");
    const size = 4 << 20;
    const big = (c: string) => c.repeat(size);
    await container.access.install([credential(big("a"), 77, ["o/a"])], dir);
    const file = path.join(dir, "notation-achq-77-o_a.token");

    // Reads the file in a loop until told to stop. Counts reads that are neither all-a nor all-b.
    const watch = () => {
      const script = `const fs = require("fs"); let torn = 0, reads = 0; const stop = Date.now() + 1500;
        while (Date.now() < stop) { const s = fs.readFileSync(process.argv[1], "utf8"); reads++;
          if (!(s.length === ${size} && (s[0] === "a" || s[0] === "b") && s.indexOf(s[0] === "a" ? "b" : "a") < 0)) torn++; }
        console.log(JSON.stringify({ torn, reads }));`;
      return Bun.spawn(["bun", "-e", script, file], { stdout: "pipe" });
    };
    const churn = async (write: (i: number) => void | Promise<void>) => {
      const reader = watch();
      const until = Date.now() + 1700;
      for (let i = 0; Date.now() < until; i++) await write(i);
      return JSON.parse(await new Response(reader.stdout).text()) as { torn: number; reads: number };
    };

    // Control: a plain write in place is seen half-written, so this test can tell.
    const plain = await churn((i) => fs.writeFileSync(file, big(i % 2 ? "a" : "b")));
    expect(plain.torn).toBeGreaterThan(0);

    const atomic = await churn((i) => container.access.install([credential(big(i % 2 ? "a" : "b"), 77, ["o/a"])], dir).then(() => {}));
    expect(atomic.reads).toBeGreaterThan(10);
    expect(atomic.torn).toBe(0);
  }, 15_000);
});

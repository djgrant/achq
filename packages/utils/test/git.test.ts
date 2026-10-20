import { afterEach, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Git, remoteUrl, repoRoot } from "../src/git.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmpDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "utils-git-")));
  dirs.push(dir);
  return dir;
};

const origin = async () => {
  const dir = tmpDir();
  await $`git init -q -b main ${dir}`.quiet();
  fs.mkdirSync(path.join(dir, ".achq"));
  fs.writeFileSync(path.join(dir, ".achq", "config.ts"), "export {};\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=t -c user.email=t@t commit -qm init`.quiet();
  return { dir, git: new Git(dir) };
};

test("reads refs, commits and HEAD", async () => {
  const { git } = await origin();
  const head = await git.text(["rev-parse", "HEAD"]);
  expect(await git.hasRef("refs/heads/main")).toBe(true);
  expect(await git.hasRef("refs/heads/nope")).toBe(false);
  expect(await git.hasCommit(head)).toBe(true);
  expect(await git.hasCommit("0".repeat(40))).toBe(false);
  expect(await new Git(path.join(tmpDir(), "missing")).hasCommit(head)).toBe(false);
  expect(await git.currentBranch()).toBe("main");
  expect(head.startsWith(await git.shortHead())).toBe(true);
});

test("run throws with git's stderr", async () => {
  const { git } = await origin();
  await expect(git.run(["rev-parse", "--verify", "nope"])).rejects.toThrow("git rev-parse --verify nope: fatal");
  expect(await git.ok(["rev-parse", "--verify", "nope"])).toBe(false);
});

test("a bare mirror with worktrees on existing and new branches", async () => {
  const { dir } = await origin();
  const mirror = new Git(path.join(tmpDir(), "mirror.git"));
  await mirror.initBare();
  await mirror.run(["remote", "add", "origin", dir]);
  await mirror.run(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await mirror.fetch("origin", { prune: true });
  expect(await mirror.hasRef("refs/remotes/origin/main")).toBe(true);

  const work = tmpDir();
  await mirror.worktreeAdd(path.join(work, "a"), { branch: "feature", from: "origin/main", track: false });
  expect(await new Git(path.join(work, "a")).currentBranch()).toBe("feature");
  await mirror.worktreeAdd(path.join(work, "b"), { branch: "main", from: "origin/main", track: true });
  expect(await new Git(path.join(work, "b")).text(["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/main");

  fs.rmSync(path.join(work, "a"), { recursive: true });
  await mirror.worktreePrune();
  await mirror.worktreeAdd(path.join(work, "c"), { branch: "feature" });
  expect(await new Git(path.join(work, "c")).currentBranch()).toBe("feature");
});

test("archive gives a path at a commit, or says it isn't there", async () => {
  const { git } = await origin();
  const tar = await git.archive("HEAD", ".achq");
  expect(tar.length).toBeGreaterThan(0);
  await expect(git.archive("HEAD", "missing")).rejects.toThrow("No missing/ at HEAD");
});

test("repoRoot and remoteUrl, synchronously", async () => {
  const { dir, git } = await origin();
  fs.mkdirSync(path.join(dir, "sub"));
  expect(repoRoot(path.join(dir, "sub"))).toBe(dir);
  expect(repoRoot(tmpDir())).toBeUndefined();
  expect(remoteUrl(dir, "origin")).toBeUndefined();
  await git.run(["remote", "add", "origin", "https://example.com/a/b.git"]);
  expect(remoteUrl(dir, "origin")).toBe("https://example.com/a/b.git");
});

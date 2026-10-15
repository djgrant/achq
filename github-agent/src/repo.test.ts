import { afterEach, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeHead, ensureWorktree, fetchMirror } from "./repo.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A remote with `main` and an existing `issue-2` branch. */
const setup = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-agent-"));
  dirs.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  await $`git init -q --bare -b main ${remote}`.quiet();
  await $`git init -q -b main ${seed}`.quiet();
  const git = (...args: string[]) => $`git -C ${seed} -c user.name=t -c user.email=t@t ${args}`.quiet();
  fs.writeFileSync(path.join(seed, "f.txt"), "main\n");
  await git("add", "-A");
  await git("commit", "-qm", "init");
  await git("checkout", "-qb", "issue-2");
  fs.writeFileSync(path.join(seed, "f.txt"), "issue 2\n");
  await git("commit", "-qam", "work on 2");
  await git("push", "-q", remote, "main", "issue-2");
  return { root, remote, mirror: path.join(root, "repo.git"), wt: (n: number) => path.join(root, "worktrees", `issue-${n}`) };
};

test("creates new issue worktrees from the default branch", async () => {
  const { remote, mirror, wt } = await setup();
  await fetchMirror(mirror, remote);
  await ensureWorktree(mirror, wt(1), 1, "main");
  expect(await describeHead(wt(1))).toMatchObject({ branch: "issue-1" });
  expect(fs.readFileSync(path.join(wt(1), "f.txt"), "utf8")).toBe("main\n");
});

test("checks out an existing remote issue branch", async () => {
  const { remote, mirror, wt } = await setup();
  await fetchMirror(mirror, remote);
  await ensureWorktree(mirror, wt(2), 2, "main");
  expect(fs.readFileSync(path.join(wt(2), "f.txt"), "utf8")).toBe("issue 2\n");
});

test("leaves an existing worktree alone, and fetching doesn't move its branch", async () => {
  const { remote, mirror, wt } = await setup();
  await fetchMirror(mirror, remote);
  await ensureWorktree(mirror, wt(1), 1, "main");
  fs.writeFileSync(path.join(wt(1), "f.txt"), "uncommitted\n");
  await fetchMirror(mirror, remote);
  await ensureWorktree(mirror, wt(1), 1, "main");
  expect(fs.readFileSync(path.join(wt(1), "f.txt"), "utf8")).toBe("uncommitted\n");
});

test("recreates a deleted worktree from its local branch", async () => {
  const { remote, mirror, wt } = await setup();
  await fetchMirror(mirror, remote);
  await ensureWorktree(mirror, wt(1), 1, "main");
  await $`git -C ${wt(1)} -c user.name=t -c user.email=t@t commit -q --allow-empty -m local`.quiet();
  fs.rmSync(wt(1), { recursive: true });
  await ensureWorktree(mirror, wt(1), 1, "main");
  expect((await $`git -C ${wt(1)} log -1 --format=%s`.text()).trim()).toBe("local");
});

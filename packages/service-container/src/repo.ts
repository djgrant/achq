import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

export type Env = Record<string, string | undefined>;

/** Serialises operations on the shared mirror within this process. */
let tail: Promise<unknown> = Promise.resolve();
export const mirrorLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = tail.then(fn);
  tail = result.catch(() => {});
  return result;
};

/**
 * A bare mirror of the repo with one worktree per thread. Remote branches are
 * fetched as remote-tracking refs, so fetching never moves a branch that a
 * thread's worktree has checked out. `env` carries the credentials git uses.
 */
export const fetchMirror = (mirror: string, url: string, env: Env = process.env) =>
  mirrorLock(async () => {
    if (!fs.existsSync(mirror)) {
      await $`git init -q --bare ${mirror}`.env(env).quiet();
      await $`git -C ${mirror} remote add origin ${url}`.env(env).quiet();
      await $`git -C ${mirror} config remote.origin.fetch ${"+refs/heads/*:refs/remotes/origin/*"}`.env(env).quiet();
    }
    await $`git -C ${mirror} fetch -q --prune origin`.env(env).quiet();
  });

export const hasCommit = async (mirror: string, commit: string) =>
  fs.existsSync(mirror) && (await $`git -C ${mirror} cat-file -e ${`${commit}^{commit}`}`.quiet().nothrow()).exitCode === 0;

/** Extracts `dir` (e.g. `.achq`) at `commit` into `dest`. */
export const extractTree = async (mirror: string, commit: string, dir: string, dest: string) => {
  fs.mkdirSync(dest, { recursive: true });
  const archive = await $`git -C ${mirror} archive --format=tar ${commit} ${dir}`.quiet().nothrow();
  if (archive.exitCode !== 0) throw new Error(`No ${dir}/ at ${commit}: ${archive.stderr.toString().trim()}`);
  await $`tar -x -C ${dest} < ${archive.stdout}`.quiet();
};

/**
 * Creates the thread's worktree on first use, on `branch`: the local branch if
 * one exists, else tracking the remote branch, else new from `origin/<base>`.
 * An existing worktree is left exactly as it is: it's the sessions' working state.
 */
export const ensureWorktree = async (mirror: string, dir: string, branch: string, base: string, env: Env = process.env) => {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await mirrorLock(async () => {
    const git = (args: string[]) => $`git -C ${mirror} ${args}`.env(env).quiet();
    await git(["worktree", "prune"]);
    const has = async (ref: string) => (await git(["rev-parse", "-q", "--verify", ref]).nothrow()).exitCode === 0;
    if (await has(`refs/heads/${branch}`)) await git(["worktree", "add", "-q", dir, branch]);
    else if (await has(`refs/remotes/origin/${branch}`)) await git(["worktree", "add", "-q", "--track", "-b", branch, dir, `origin/${branch}`]);
    else if (await has(`refs/remotes/origin/${base}`)) await git(["worktree", "add", "-q", "--no-track", "-b", branch, dir, `origin/${base}`]);
    else throw new Error(`The base branch \`${base}\` doesn't exist on the remote`);
  });
};

export const describeHead = async (dir: string) => ({
  branch: (await $`git -C ${dir} branch --show-current`.quiet().text()).trim() || "(detached)",
  head: (await $`git -C ${dir} rev-parse --short HEAD`.quiet().text()).trim(),
});

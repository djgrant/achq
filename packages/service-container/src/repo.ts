// A bare mirror of the repo with one worktree per thread. Remote branches are
// fetched as remote-tracking refs, so fetching never moves a branch that a
// thread's worktree has checked out. `env` carries the credentials git uses.
import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { serial } from "@achq/utils/async";
import { ensureDir } from "@achq/utils/fs";
import { Git, type WorktreeBranch } from "@achq/utils/git";

export type Env = Record<string, string | undefined>;

const ORIGIN = "origin";
/** Remote branches land beside local ones rather than on them. */
const REMOTE_TRACKING_REFSPEC = `+refs/heads/*:refs/remotes/${ORIGIN}/*`;
const DETACHED = "(detached)";

/** Serialises operations on the shared mirror within this process. */
export const mirrorLock = serial();

export const fetchMirror = (mirror: string, url: string, env: Env = process.env) =>
  mirrorLock(async () => {
    const git = new Git(mirror, env);
    if (!git.exists()) await initMirror(git, url);
    await git.fetch(ORIGIN, { prune: true });
  });

const initMirror = async (git: Git, url: string) => {
  await git.initBare();
  await git.run(["remote", "add", ORIGIN, url]);
  await git.run(["config", `remote.${ORIGIN}.fetch`, REMOTE_TRACKING_REFSPEC]);
};

export const hasCommit = (mirror: string, commit: string) => new Git(mirror).hasCommit(commit);

export const extractTree = async (mirror: string, commit: string, dir: string, dest: string) => {
  ensureDir(dest);
  await extractArchive(await new Git(mirror).archive(commit, dir), dest);
};

const extractArchive = async (tar: Buffer, dest: string) => {
  await $`tar -x -C ${dest} < ${tar}`.quiet();
};

/**
 * Creates the thread's worktree on first use, on `branch`. An existing
 * worktree is left exactly as it is: it's the sessions' working state.
 */
export const ensureWorktree = async (mirror: string, dir: string, branch: string, base: string, env: Env = process.env) => {
  if (fs.existsSync(dir)) return;
  ensureDir(path.dirname(dir));
  await mirrorLock(async () => {
    const git = new Git(mirror, env);
    await git.worktreePrune();
    await git.worktreeAdd(dir, await worktreeSource(git, branch, base));
  });
};

const worktreeSource = async (git: Git, branch: string, base: string): Promise<WorktreeBranch> => {
  if (await git.hasRef(`refs/heads/${branch}`)) return { branch };
  if (await git.hasRef(`refs/remotes/${ORIGIN}/${branch}`)) return { branch, from: `${ORIGIN}/${branch}`, track: true };
  if (await git.hasRef(`refs/remotes/${ORIGIN}/${base}`)) return { branch, from: `${ORIGIN}/${base}`, track: false };
  throw new Error(`The base branch \`${base}\` doesn't exist on the remote`);
};

export const describeHead = async (dir: string) => {
  const git = new Git(dir);
  return { branch: (await git.currentBranch()) ?? DETACHED, head: await git.shortHead() };
};

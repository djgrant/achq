import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A bare mirror of the repo with one worktree per issue. Remote branches are
 * fetched as remote-tracking refs, so fetching never moves a branch that an
 * issue's worktree has checked out.
 */
export const fetchMirror = async (mirror: string, url: string) => {
  if (!fs.existsSync(mirror)) {
    await $`git init -q --bare ${mirror}`.quiet();
    await $`git -C ${mirror} remote add origin ${url}`.quiet();
    await $`git -C ${mirror} config remote.origin.fetch ${"+refs/heads/*:refs/remotes/origin/*"}`.quiet();
  }
  await $`git -C ${mirror} fetch -q --prune origin`.quiet();
};

/**
 * Creates the issue's worktree on first use, on `issue-<n>`, tracking the
 * remote branch if one exists. An existing worktree is left exactly as it is:
 * it's the session's working state.
 */
export const ensureWorktree = async (mirror: string, dir: string, issue: number, defaultBranch: string) => {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await $`git -C ${mirror} worktree prune`.quiet();
  const branch = `issue-${issue}`;
  const has = async (ref: string) =>
    (await $`git -C ${mirror} rev-parse -q --verify ${ref}`.quiet().nothrow()).exitCode === 0;
  if (await has(`refs/heads/${branch}`)) {
    await $`git -C ${mirror} worktree add -q ${dir} ${branch}`.quiet();
  } else if (await has(`refs/remotes/origin/${branch}`)) {
    await $`git -C ${mirror} worktree add -q --track -b ${branch} ${dir} origin/${branch}`.quiet();
  } else {
    await $`git -C ${mirror} worktree add -q --no-track -b ${branch} ${dir} origin/${defaultBranch}`.quiet();
  }
};

export const describeHead = async (dir: string) => ({
  branch: (await $`git -C ${dir} branch --show-current`.quiet().text()).trim() || "(detached)",
  head: (await $`git -C ${dir} rev-parse --short HEAD`.quiet().text()).trim(),
});

/** Points git at the App's rotating token and makes commits come from the bot. */
export const configureGit = async (bot: { login: string; id: number }, tokenFile: string) => {
  await $`git config --global user.name ${bot.login}`.quiet();
  await $`git config --global user.email ${`${bot.id}+${bot.login}@users.noreply.github.com`}`.quiet();
  const helper = `!f() { test "$1" = get && echo username=x-access-token && echo "password=$(cat ${tokenFile})"; }; f`;
  await $`git config --global credential.https://github.com.helper ${helper}`.quiet();
};

import { $ } from "bun";
import * as fs from "node:fs";
import type { Vars } from "./env.ts";
import { subprocess } from "./subprocess.ts";

/** Where a new worktree's branch comes from: an existing local branch, or a new one started at `from`. */
export type WorktreeBranch = { branch: string; from?: undefined } | { branch: string; from: string; track: boolean };

export class Git {
  constructor(
    readonly dir: string,
    readonly env: Vars = process.env,
  ) {}

  /** The root of the repo `dir` is in, or undefined outside one. */
  static root(dir: string): string | undefined {
    return subprocess.tryRun(["git", "rev-parse", "--show-toplevel"], { cwd: dir });
  }

  static remoteUrl(dir: string, name: string): string | undefined {
    return subprocess.tryRun(["git", "remote", "get-url", name], { cwd: dir });
  }

  private exec(args: string[]) {
    return $`git -C ${this.dir} ${args}`.env(this.env).quiet().nothrow();
  }

  /** Throws with git's stderr if it fails. */
  async run(args: string[]): Promise<Buffer> {
    const result = await this.exec(args);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
    return result.stdout;
  }

  async text(args: string[]): Promise<string> {
    return (await this.run(args)).toString().trim();
  }

  async ok(args: string[]): Promise<boolean> {
    return (await this.exec(args)).exitCode === 0;
  }

  exists(): boolean {
    return fs.existsSync(this.dir);
  }

  /** Whether `ref` (e.g. `refs/heads/main`) exists. */
  hasRef(ref: string): Promise<boolean> {
    return this.ok(["rev-parse", "-q", "--verify", ref]);
  }

  async hasCommit(commit: string): Promise<boolean> {
    return this.exists() && this.ok(["cat-file", "-e", `${commit}^{commit}`]);
  }

  async initBare(): Promise<void> {
    await $`git init -q --bare ${this.dir}`.env(this.env).quiet();
  }

  async fetch(remote: string, { prune = false }: { prune?: boolean } = {}): Promise<void> {
    await this.run(["fetch", "-q", ...(prune ? ["--prune"] : []), remote]);
  }

  async worktreeAdd(path: string, on: WorktreeBranch): Promise<void> {
    if (on.from === undefined) return void (await this.run(["worktree", "add", "-q", path, on.branch]));
    await this.run(["worktree", "add", "-q", on.track ? "--track" : "--no-track", "-b", on.branch, path, on.from]);
  }

  async worktreePrune(): Promise<void> {
    await this.run(["worktree", "prune"]);
  }

  async archive(commit: string, path: string): Promise<Buffer> {
    const result = await this.exec(["archive", "--format=tar", commit, path]);
    if (result.exitCode !== 0) throw new Error(`No ${path}/ at ${commit}: ${result.stderr.toString().trim()}`);
    return result.stdout;
  }

  /** Undefined when HEAD is detached. */
  async currentBranch(): Promise<string | undefined> {
    return (await this.text(["branch", "--show-current"])) || undefined;
  }

  shortHead(): Promise<string> {
    return this.text(["rev-parse", "--short", "HEAD"]);
  }
}

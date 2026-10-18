import * as fs from "node:fs";
import * as path from "node:path";

/** The directory `achq` was run in. `bin/achq` passes it on, since pok runs from achq's own directory. */
export const callerCwd = () => process.env.ACHQ_CALLER_CWD ?? process.cwd();

/** The git repo `dir` is in, or `dir` itself outside one. */
export const repoRoot = (dir = callerCwd()) => {
  const { stdout, success } = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stderr: "ignore" });
  return success ? stdout.toString().trim() : dir;
};

/** The ACHQ infra file, at the infra repo's root. */
export const INFRA_FILE = "achq.infra.ts";

export const infraFile = (dir = callerCwd()) => {
  const file = path.join(repoRoot(dir), INFRA_FILE);
  return fs.existsSync(file) ? file : undefined;
};

/** The GitHub repo of `dir`'s `origin`, if it has one. */
export const originRepo = (dir = callerCwd()): string | undefined => {
  const { stdout, success } = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir, stderr: "ignore" });
  return success ? stdout.toString().trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] : undefined;
};

export const needRepo = (dir = callerCwd()) => {
  const repo = originRepo(dir);
  if (!repo) throw new Error("Run this in a clone of a GitHub repo (its origin decides which repo)");
  return repo;
};

/** A secret from the environment. Values like op://vault/item/field are read from 1Password. */
export const need = (name: string, hint = "") => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in the environment.${hint ? ` ${hint}` : ""}`);
  if (!value.startsWith("op://")) return value;
  const read = Bun.spawnSync(["op", "read", value], { stderr: "pipe" });
  if (read.exitCode !== 0) throw new Error(`Couldn't read ${name} from 1Password: ${read.stderr.toString().trim()}`);
  return read.stdout.toString().trim();
};

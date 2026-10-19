import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeHostProvider } from "@achq/core";
import { CODE_HOST_PROVIDERS } from "achq/registry";
import { CLI_ENV, INFRA_FILE } from "../constants.ts";

/** The directory `achq` was run in. `bin/achq` passes it on, since pok runs from achq's own directory. */
export const callerCwd = () => process.env[CLI_ENV.callerCwd] ?? process.cwd();

/** The git repo `dir` is in, or `dir` itself outside one. */
export const repoRoot = (dir = callerCwd()) => {
  const { stdout, success } = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stderr: "ignore" });
  return success ? stdout.toString().trim() : dir;
};

export const infraFile = (dir = callerCwd()) => {
  const file = path.join(repoRoot(dir), INFRA_FILE);
  return fs.existsSync(file) ? file : undefined;
};

/** `dir`'s `origin` URL, if it has one. */
export const originUrl = (dir = callerCwd()): string | undefined => {
  const { stdout, success } = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir, stderr: "ignore" });
  return success ? stdout.toString().trim() : undefined;
};

export type RepoHere = { host: string; repo: string; codeHost: CodeHostProvider };

/** The repo `remote` names, on whichever host has it. */
export const repoAt = (remote: string, env: Record<string, string | undefined> = process.env): RepoHere | undefined => {
  for (const h of CODE_HOST_PROVIDERS) {
    const codeHost = h.create(env);
    const repo = codeHost.repoOf(remote);
    if (repo) return { host: h.id, repo, codeHost };
  }
};

export const needRepo = (dir = callerCwd()): RepoHere => {
  const remote = originUrl(dir);
  const found = remote ? repoAt(remote) : undefined;
  if (!found) throw new Error(`Run this in a clone of a repo on ${CODE_HOST_PROVIDERS.map((h) => h.id).join(" or ")} (its origin decides which repo)`);
  return found;
};

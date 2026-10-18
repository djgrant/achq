import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderCli } from "@achq/core";
import { PROVIDERS } from "achq/registry";
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

export type RepoHere = { host: string; repo: string; cli: ProviderCli };

/** The repo `remote` names, on whichever provider hosts it. */
export const repoAt = (remote: string, env: Record<string, string | undefined> = process.env): RepoHere | undefined => {
  for (const p of PROVIDERS) {
    const cli = p.cli?.(env);
    const repo = cli?.repoOf(remote);
    if (cli && repo) return { host: p.id, repo, cli };
  }
};

export const needRepo = (dir = callerCwd()): RepoHere => {
  const remote = originUrl(dir);
  const found = remote ? repoAt(remote) : undefined;
  if (!found) throw new Error(`Run this in a clone of a repo on ${PROVIDERS.filter((p) => p.cli).map((p) => p.id).join(" or ")} (its origin decides which repo)`);
  return found;
};

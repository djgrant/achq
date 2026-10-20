import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeHostProvider } from "@achq/core";
import type { Env } from "@achq/utils/env";
import * as git from "@achq/utils/git";
import { z } from "zod";
import { CODE_HOST_PROVIDERS } from "achq/registry";
import { CLI_ENV, INFRA_FILE } from "../constants.ts";

/** The directory `achq` was run in. `bin/achq` passes it on, since pok runs from achq's own directory. */
export const callerCwd = () => process.env[CLI_ENV.callerCwd] ?? process.cwd();

/** The git repo `dir` is in, or `dir` itself outside one. */
export const repoRoot = (dir = callerCwd()) => git.repoRoot(dir) ?? dir;

/** The infra file at the root of `dir`'s repo, if it's the ACHQ infra repo. */
export const infraFile = (dir = callerCwd()) => {
  const file = path.join(repoRoot(dir), INFRA_FILE);
  return fs.existsSync(file) ? file : undefined;
};

/** The infra file, or an error saying where to run. */
export const needInfra = (dir = callerCwd()) => {
  const file = infraFile(dir);
  if (!file) throw new Error(`Run this in the ACHQ infra repo, which has ${INFRA_FILE} at its root`);
  return file;
};

export const originUrl = (dir = callerCwd()): string | undefined => git.remoteUrl(dir, "origin");

export type RepoHere = { host: string; repo: string; codeHost: CodeHostProvider };

/** The repo `remote` names, on whichever host has it. */
export const repoAt = (remote: string, env: Env = process.env): RepoHere | undefined => {
  for (const h of CODE_HOST_PROVIDERS) {
    const codeHost = h.create(env);
    const repo = codeHost.repoOf(remote);
    if (repo) return { host: h.id, repo, codeHost };
  }
};

const knownHosts = () => CODE_HOST_PROVIDERS.map((h) => h.id).join(" or ");

/** The repo `name` (`owner/name`) is, on the one host whose names it fits. */
const repoNamed = (name: string, env: Env = process.env): RepoHere | undefined => {
  const fits = CODE_HOST_PROVIDERS.map((h) => ({ host: h.id, repo: name, codeHost: h.create(env) })).filter((h) => h.codeHost.repoName.test(name));
  if (fits.length > 1) throw new Error(`${name} could be on ${fits.map((h) => h.host).join(" or ")}; pass its URL`);
  return fits[0];
};

/** For a repo achq has never deployed. */
export const notSetUp = (repo: string) => `${repo} isn't set up yet. To set it up, run \`achq repo install\`.`;

export const repoFlag = { from: "flag", schema: z.string().optional(), description: "owner/name or URL (default: origin)" } as const;

/** The repo `wanted` names, as `owner/name` or a remote URL, or else the one `dir`'s origin names. */
export const needRepo = (wanted?: string, dir = callerCwd()): RepoHere => {
  if (wanted) {
    const found = repoAt(wanted) ?? repoNamed(wanted);
    if (!found) throw new Error(`${wanted} isn't a repo on ${knownHosts()}`);
    return found;
  }
  const remote = originUrl(dir);
  const found = remote ? repoAt(remote) : undefined;
  if (!found) throw new Error(`Run this in a clone of a repo on ${knownHosts()}, or pass --repo`);
  return found;
};

import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeHostAsYou } from "@achq/core";
import type { Vars } from "@achq/utils/env";
import { Git } from "@achq/utils/git";
import { z } from "zod";
import { CODE_HOST } from "achq/registry";

/** The ACHQ infra file, at the infra repo's root. */
const INFRA_FILE = "achq.infra.ts";

/** The directory `achq` was run in. `bin/achq` passes it on, since pok runs from achq's own directory. */
const CALLER_CWD = "ACHQ_CALLER_CWD";

export type RepoHere = { repo: string; codeHost: CodeHostAsYou };

/** The directory `achq` was run in. */
export const callerCwd = () => process.env[CALLER_CWD] ?? process.cwd();

/** The git repo `dir` is in, or `dir` itself outside one. */
export const repoRoot = (dir = callerCwd()) => Git.root(dir) ?? dir;

/** The infra file at the root of `dir`'s repo, or an error saying where to run. */
export const needInfra = (dir = callerCwd()) => {
  const file = path.join(repoRoot(dir), INFRA_FILE);
  if (!fs.existsSync(file)) throw new Error(`Run this in the ACHQ infra repo, which has ${INFRA_FILE} at its root`);
  return file;
};

/** The repo on the code host that `remote` (a URL) or `name` (`owner/name`) names. */
const repoOn = (codeHost: CodeHostAsYou, wanted: string): RepoHere | undefined => {
  const repo = codeHost.repoOf(wanted) ?? (codeHost.repoName.test(wanted) ? wanted : undefined);
  return repo ? { repo, codeHost } : undefined;
};

/** For a repo achq has never deployed. */
export const notSetUp = (repo: string) => `${repo} isn't set up yet. To set it up, run \`achq repo install\`.`;

export const repoFlag = { from: "flag", schema: z.string().optional(), description: "owner/name or URL (default: origin)" } as const;

/** The repo `wanted` names, as `owner/name` or a remote URL, or else the one `dir`'s origin names. */
export const needRepo = (wanted?: string, dir = callerCwd(), env: Vars = process.env): RepoHere => {
  const codeHost = CODE_HOST.asYou(env);
  if (wanted) {
    const found = repoOn(codeHost, wanted);
    if (!found) throw new Error(`${wanted} isn't a repo on ${CODE_HOST.id}`);
    return found;
  }
  const remote = Git.remoteUrl(dir, "origin");
  const repo = remote ? codeHost.repoOf(remote) : undefined;
  if (!repo) throw new Error(`Run this in a clone of a repo on ${CODE_HOST.id}, or pass --repo`);
  return { repo, codeHost };
};

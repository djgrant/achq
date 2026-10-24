import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR, CONFIG_ENTRY, plan, type RepoRequest, type Status } from "@achq/core";
import { context } from "@achq/core/context";
import { evaluateConfig } from "@achq/deployer/config";
import { async } from "@achq/utils/async";
import { disk } from "@achq/utils/disk";
import { http } from "@achq/utils/http";
import { text } from "@achq/utils/text";
import { FIX_ATTEMPTS, STATUS_INTERVAL_MS, STATUS_TIMEOUT_MS } from "../constants.ts";
import { planLines } from "./format.ts";
import { openInBrowser } from "./terminal.ts";
import { needRepo, repoRoot } from "./workdir.ts";

/** Installed packages under `.achq/` are not part of the config. */
const SKIPPED_DIRS = ["node_modules"];

export type WaitOptions = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };

/** The repo's manifest, evaluated in the sandbox as the deployer does it, from every file under its `.achq/`. */
export const loadRepoManifest = async (repoDir: string) => {
  const dir = path.join(repoDir, CONFIG_DIR);
  if (!fs.existsSync(path.join(dir, CONFIG_ENTRY))) throw new Error(`No ${CONFIG_DIR}/${CONFIG_ENTRY} in ${repoDir}`);
  return evaluateConfig(disk.readTree(dir, { skip: SKIPPED_DIRS }));
};

/** Plans installing or uninstalling this repo on its code host and prints the plan. `apply` is undefined when nothing would change. */
export const planInstall = async (action: "install" | "uninstall") => {
  const { host, repo, codeHost } = needRepo();
  const config = await loadRepoManifest(repoRoot());
  const resources = action === "install" ? codeHost.install(repo, config) : codeHost.uninstall(repo, config);
  const planned = await plan(resources, context({ env: process.env, log: (line) => console.log(line), open: openInBrowser }));
  for (const line of planLines(planned)) console.log(line);
  if (planned.changes.length) return { host, repo, codeHost, apply: () => planned.apply() };
  // e.g. `app is already installed on a/b`, or `app isn't installed on a/b`.
  const n = resources.length;
  const state = action === "install" ? `${text.plural(n, "is", "are")} already installed` : `${text.plural(n, "isn't", "aren't")} installed`;
  console.log(`${resources.map((r) => r.name).join(", ")} ${state} on ${repo}`);
  return { host, repo, codeHost, apply: undefined };
};

/** The repo's status once one turns up that was written after `since`, rather than one left from before. Undefined if none does in time. */
export const waitForStatus = (
  status: (repo: string) => Promise<Status | undefined>,
  repo: string,
  since: Date,
  { timeoutMs = STATUS_TIMEOUT_MS, intervalMs = STATUS_INTERVAL_MS, sleep = Bun.sleep }: WaitOptions = {},
) => async.pollUntil(() => status(repo), (found) => !!found && Date.parse(found.at) > since.getTime(), { timeoutMs, intervalMs, sleep });

/** Has the router deploy the repo again, as installing it does. It checks, with your code host token, that you can push to it. */
export const redeploy = async (router: string, request: RepoRequest, token: string) => {
  const res = await fetch(`${router}/deploy`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(request satisfies RepoRequest) });
  await http.expectOk(res, `The router couldn't deploy ${request.repo} again`);
};

export type FixDeps = {
  status: (repo: string) => Promise<Status | undefined>;
  /** Whether there's someone at a terminal to wait for. */
  interactive: boolean;
  open: (url: string, what: string) => Promise<void>;
  /** Waits until you say you've done it. */
  waitForYou: () => Promise<void>;
  redeploy: (router: string, repo: string) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  wait?: WaitOptions;
};

/**
 * While the repo's deploy failed with something only you can fix in your
 * browser, whatever the container provider: opens it, waits for you, has the
 * router deploy again, and waits for that result. Without a terminal, says
 * what to do and stops. The last status, or undefined if none came in time.
 */
export const fixInBrowser = async (repo: string, status: Status | undefined, deps: FixDeps) => {
  const now = deps.now ?? (() => new Date());
  for (let attempt = 0; status?.state === "failed" && status.action && attempt < FIX_ATTEMPTS; attempt++) {
    const { url, what } = status.action;
    if (!deps.interactive) {
      deps.log(`To fix it, ${what} at ${url}, then run \`achq repo install\` again.`);
      return status;
    }
    deps.log(`The deploy needs you to ${what}.`);
    await deps.open(url, what);
    await deps.waitForYou();
    const since = now();
    await deps.redeploy(status.router, repo);
    deps.log("Deploying again…");
    status = await waitForStatus(deps.status, repo, since, deps.wait);
  }
  return status;
};

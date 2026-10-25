import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR, CONFIG_ENTRY, type RepoInstallation, repoName, type Status } from "@achq/core";
import type { RepoManifest } from "@achq/core/manifest";
import { routerForPusher } from "@achq/core/clients/router";
import { evaluateConfig } from "@achq/deployer/config";
import { async } from "@achq/utils/async";
import { disk } from "@achq/utils/disk";
import { errors } from "@achq/utils/errors";
import { HttpError } from "@achq/utils/http";
import { FIX_ATTEMPTS, STATUS_INTERVAL_MS, STATUS_TIMEOUT_MS, UNINSTALL_INTERVAL_MS, UNINSTALL_TIMEOUT_MS } from "../constants.ts";
import type { RepoHere } from "./workdir.ts";

/** Installed packages under `.achq/` are not part of the config. */
const SKIPPED_DIRS = ["node_modules"];
const NOT_FOUND = 404;

export type WaitOptions = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };

/** The repo's manifest, evaluated in the sandbox as the deployer does it, from every file under its `.achq/`. */
export const loadRepoManifest = async (repoDir: string) => {
  const dir = path.join(repoDir, CONFIG_DIR);
  if (!fs.existsSync(path.join(dir, CONFIG_ENTRY))) throw new Error(`No ${CONFIG_DIR}/${CONFIG_ENTRY} in ${repoDir}`);
  return evaluateConfig(disk.readTree(dir, { skip: SKIPPED_DIRS }));
};

export type FlowDeps = {
  log: (line: string) => void;
  /** Opens your browser at `url` to do `what`. */
  open: (url: string, what: string) => Promise<void>;
  wait?: WaitOptions;
};

/**
 * The router ACHQ_STATUS names, and whether `source` is installed on the repo
 * as it says: it checks you can push to the repo. Undefined when there's no
 * ACHQ_STATUS naming one, and no `installation` when nothing answers there: a
 * 404, as from a router torn down, or one that doesn't have the source.
 */
const askRouter = async ({ repo, codeHost }: RepoHere, source: string): Promise<{ router: string; installation?: RepoInstallation } | undefined> => {
  const router = (await codeHost.status(repo))?.router;
  if (!router) return undefined;
  try {
    return { router, installation: await routerForPusher({ url: router, token: codeHost.token() }).installation({ body: { repo, source } }) };
  } catch (error) {
    if (error instanceof HttpError && error.status === NOT_FOUND) return { router };
    throw error;
  }
};

/**
 * Where to install the config's source on the repo, or undefined when it's
 * installed already. Refuses a source lacking what the config needs. Without
 * a router to ask, the repo's never been deployed, or its hq is gone, e.g.
 * moved to another provider, whose deploy names its own router: either way,
 * the source's install page.
 */
export const planInstall = async (here: RepoHere, manifest: RepoManifest, { log }: Pick<FlowDeps, "log">) => {
  const { repo, codeHost } = here;
  const source = codeHost.sourceOf(manifest);
  const { missing, warnings } = await codeHost.checkSource(source, manifest);
  if (missing.length) throw new Error(`${source} doesn't have what ${repo}'s config needs: ${missing.join(", ")}`);
  for (const warning of warnings) log(`! ${warning}`);
  const found = (await askRouter(here, source))?.installation;
  if (found?.installed) {
    log(`${source} is already installed on ${repo}`);
    return { source, url: undefined };
  }
  const url = found?.url ?? codeHost.installPage(source);
  log(`+ ${source} on ${repo}: opens your browser to install it`);
  return { source, url };
};

/** Opens your browser where you install `source` on the repo. */
export const openInstall = async ({ repo, codeHost }: RepoHere, source: string, url: string, { log, open }: FlowDeps) => {
  log(codeHost.howTo("install", source, repo, url));
  await open(url, `install ${source} on ${repo}`);
};

/** The source's installation on the repo, when the router ACHQ_STATUS names can say: uninstalling needs it to. */
const installationToRemove = async (here: RepoHere, source: string) => {
  const { repo, codeHost } = here;
  const { owner } = repoName.split(repo);
  const asked = await askRouter(here, source);
  if (!asked) throw new Error(`achq can't tell whether ${source} is installed on ${repo}: ${codeHost.statusLocation(repo)} doesn't name its router yet. Remove it from ${source}'s installation in ${owner}'s settings`);
  if (!asked.installation)
    throw new Error(`No router answers at ${asked.router}, which ${codeHost.statusLocation(repo)} names: its hq may have been torn down. Bring it back with \`achq infra up\`, or remove ${source} from its installation in ${owner}'s settings`);
  return asked.installation;
};

/** Where to remove the config's source from the repo, or undefined when it isn't installed. */
export const planUninstall = async (here: RepoHere, manifest: RepoManifest, { log }: Pick<FlowDeps, "log">) => {
  const { repo, codeHost } = here;
  const source = codeHost.sourceOf(manifest);
  const found = await installationToRemove(here, source);
  if (!found.installed) {
    log(`${source} isn't installed on ${repo}`);
    return { source, url: undefined };
  }
  log(`- ${source} on ${repo}: opens your browser to remove it`);
  return { source, url: found.url };
};

/**
 * Opens your browser where you remove the repo from `source`, waits until the
 * router says it's gone, then deletes ACHQ_STATUS with your login: the source
 * can't reach the repo any more. Without it, the repo is as if never deployed,
 * so installing again opens the source's install page.
 */
export const removeAndWait = async (here: RepoHere, source: string, url: string, { log, open, wait = {} }: FlowDeps) => {
  const { repo, codeHost } = here;
  log(codeHost.howTo("remove", source, repo, url));
  await open(url, `remove ${repo} from ${source}'s installation`);
  await async.pollOrThrow(() => installationToRemove(here, source), (found) => !found.installed, {
    intervalMs: wait.intervalMs ?? UNINSTALL_INTERVAL_MS,
    timeoutMs: wait.timeoutMs ?? UNINSTALL_TIMEOUT_MS,
    sleep: wait.sleep,
    timedOut: (after) => `${source} is still installed on ${repo} after ${after}`,
  });
  try {
    await codeHost.clearStatus(repo);
  } catch (error) {
    log(`Couldn't delete ${codeHost.statusLocation(repo)}: ${errors.message(error)}`);
  }
  log(`${repo}'s containers sleep, and are kept until \`achq infra up --prune\`.`);
};

/** The repo's status once one turns up that was written after `since`, rather than one left from before. Undefined if none does in time. */
export const waitForStatus = (
  status: (repo: string) => Promise<Status | undefined>,
  repo: string,
  since: Date,
  { timeoutMs = STATUS_TIMEOUT_MS, intervalMs = STATUS_INTERVAL_MS, sleep = Bun.sleep }: WaitOptions = {},
) => async.pollUntil(() => status(repo), (found) => !!found && Date.parse(found.at) > since.getTime(), { timeoutMs, intervalMs, sleep });

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

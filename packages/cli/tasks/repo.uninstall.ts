import { defineTask, type Runner } from "@pokit/core";
import { repoName } from "@achq/core";
import type { RepoManifest } from "@achq/core/manifest";
import { async } from "@achq/utils/async";
import { errors } from "@achq/utils/errors";
import { time } from "@achq/utils/time";
import { z } from "zod";
import { openInBrowser } from "../io/terminal.ts";
import type { RepoHere } from "../io/workdir.ts";
import { repoAskRouter } from "./repo.ask-router.ts";
import { given, log, type Open, sleep } from "./params.ts";
import { run, runner } from "./run.ts";

/** How long you're waited for to remove the repo in your browser, and how often the router is asked whether you have. */
const UNINSTALL_TIMEOUT_MS = 15 * time.MINUTE_MS;
const UNINSTALL_INTERVAL_MS = 5000;

/** The source's installation on the repo, when the router ACHQ_STATUS names can say: uninstalling needs it to. */
const installationToRemove = async (r: Runner, here: RepoHere, source: string) => {
  const { repo, codeHost } = here;
  const { owner } = repoName.split(repo);
  const asked = await run(r, repoAskRouter, { here, source });
  if (!asked) throw new Error(`achq can't tell whether ${source} is installed on ${repo}: ${codeHost.statusLocation(repo)} doesn't name its router yet. Remove it from ${source}'s installation in ${owner}'s settings`);
  if (!asked.installation)
    throw new Error(`No router answers at ${asked.router}, which ${codeHost.statusLocation(repo)} names: its hq may have been torn down. Bring it back with \`achq infra up\`, or remove ${source} from its installation in ${owner}'s settings`);
  return asked.installation;
};

/**
 * Removes the config's source from the repo, unless it isn't installed or it's
 * a dry run: opens your browser where you remove the repo from it, waits until
 * the router says it's gone, then deletes ACHQ_STATUS with your login: the
 * source can't reach the repo any more. Without it, the repo is as if never
 * deployed, so installing again opens the source's install page. Where you
 * remove it, or undefined when it isn't installed.
 */
export const repoUninstall = defineTask({
  label: "Uninstall achq from the repo",
  params: z.object({
    here: given<RepoHere>(),
    manifest: given<RepoManifest>(),
    dryRun: z.boolean().default(false),
    /** Opens your browser where you remove the repo. */
    open: given<Open>().default(() => openInBrowser),
    log,
    sleep,
  }),
  run: async (r, { params: { here, manifest, dryRun, open, log, sleep } }) => {
    const { repo, codeHost } = here;
    const source = codeHost.sourceOf(manifest);
    const found = await installationToRemove(runner(r), here, source);
    if (!found.installed) {
      log(`${source} isn't installed on ${repo}`);
      return { source, url: undefined };
    }
    log(`- ${source} on ${repo}: opens your browser to remove it`);
    const { url } = found;
    if (dryRun) return { source, url };
    log(codeHost.howTo("remove", source, repo, url));
    await open(url, `remove ${repo} from ${source}'s installation`);
    await async.pollOrThrow(() => installationToRemove(runner(r), here, source), (found) => !found.installed, {
      intervalMs: UNINSTALL_INTERVAL_MS,
      timeoutMs: UNINSTALL_TIMEOUT_MS,
      sleep,
      timedOut: (after) => `${source} is still installed on ${repo} after ${after}`,
    });
    try {
      await codeHost.clearStatus(repo);
    } catch (error) {
      log(`Couldn't delete ${codeHost.statusLocation(repo)}: ${errors.message(error)}`);
    }
    log(`${repo}'s containers sleep, and are kept until \`achq infra up --prune\`.`);
    return { source, url };
  },
});

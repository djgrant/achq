import { defineTask, type Runner } from "@pokit/core";
import type { Status } from "@achq/core";
import type { RepoManifest } from "@achq/core/manifest";
import { routerForPusher } from "@achq/core/clients/router";
import { subprocess } from "@achq/utils/subprocess";
import { time } from "@achq/utils/time";
import { z } from "zod";
import { interactive, openInBrowser, waitForEnter } from "../io/terminal.ts";
import type { RepoHere } from "../io/workdir.ts";
import { formatStatus } from "../renderers/status.ts";
import { repoAskRouter } from "./repo.ask-router.ts";
import { repoReadStatus, STATUS_TIMEOUT_MS } from "./repo.read-status.ts";
import { given, log, type Open, sleep } from "./params.ts";
import { run, runner } from "./run.ts";

/** How many times what a failed deploy says only you can fix is opened, and the repo deployed again. */
const FIX_ATTEMPTS = 3;

/** A deploy that failed with something only you can fix, in your browser. */
const needsYou = (status: Status | undefined) => status?.state === "failed" && !!status.action;

const Params = z.object({
  here: given<RepoHere>(),
  manifest: given<RepoManifest>(),
  dryRun: z.boolean().default(false),
  /** Opens your browser where you install the config's source. */
  open: given<Open>().default(() => openInBrowser),
  /** Opens what a failed deploy says only you can fix, having said what it opens. */
  openUrl: given<(url: string) => unknown>().default(() => (url: string) => subprocess.openUrl(url)),
  /** Whether there's someone at a terminal to wait for. */
  interactive: z.boolean().default(interactive),
  now: given<() => Date>().default(() => () => new Date()),
  log,
  sleep,
});

/**
 * Where to install the config's source on the repo, or undefined when it's
 * installed already. Refuses a source lacking what the config needs. Without
 * a router to ask, the repo's never been deployed, or its hq is gone, e.g.
 * moved to another provider, whose deploy names its own router: either way,
 * the source's install page.
 */
const planInstall = async (r: Runner, { here, manifest, log }: z.output<typeof Params>) => {
  const { repo, codeHost } = here;
  const source = codeHost.sourceOf(manifest);
  const { missing, warnings } = await codeHost.checkSource(source, manifest);
  if (missing.length) throw new Error(`${source} doesn't have what ${repo}'s config needs: ${missing.join(", ")}`);
  for (const warning of warnings) log(`! ${warning}`);
  const found = (await run(r, repoAskRouter, { here, source }))?.installation;
  if (found?.installed) {
    log(`${source} is already installed on ${repo}`);
    return { source, url: undefined };
  }
  const url = found?.url ?? codeHost.installPage(source);
  log(`+ ${source} on ${repo}: opens your browser to install it`);
  return { source, url };
};

/**
 * While the repo's deploy failed with something only you can fix in your
 * browser, whatever the container provider: opens it, waits for you, has the
 * router deploy again, and waits for that result. Without a terminal, says
 * what to do and stops. The last status, or undefined if none came in time.
 */
const fixInBrowser = async (r: Runner, status: Status | undefined, params: z.output<typeof Params>) => {
  const { here, log } = params;
  const { repo, codeHost } = here;
  for (let attempt = 0; status?.state === "failed" && status.action && attempt < FIX_ATTEMPTS; attempt++) {
    const { url, what } = status.action;
    if (!params.interactive) {
      log(`To fix it, ${what} at ${url}, then run \`achq repo install\` again.`);
      return status;
    }
    log(`The deploy needs you to ${what}.`);
    log(`Opening ${url} to ${what}…`);
    params.openUrl(url);
    await waitForEnter(r.prompter, "Press Enter once you have.");
    const since = params.now();
    await routerForPusher({ url: status.router, token: codeHost.token() }).deploy({ body: { repo } });
    log("Deploying again…");
    status = await run(r, repoReadStatus, { here, since, sleep: params.sleep });
  }
  return status;
};

/**
 * Installs the config's source on the repo, opening your browser where you do,
 * and waits for the deploy that follows, then for you to fix what it says only
 * you can. Installed already, only that's left to do. Undefined when there's
 * nothing to wait for, as on a dry run, or else the last status, undefined if
 * none came in time.
 */
export const repoInstall = defineTask({
  label: "Install achq on the repo",
  params: Params,
  run: async (r, { params }) => {
    const { here, dryRun, open, now, log, sleep } = params;
    const { repo, codeHost } = here;
    const since = now();
    const { source, url } = await planInstall(runner(r), params);
    if (dryRun) return undefined;
    let status: Status | undefined;
    if (url) {
      log(codeHost.howTo("install", source, repo, url));
      await open(url, `install ${source} on ${repo}`);
      log("Waiting for the deploy's result…");
      status = await run(r, repoReadStatus, { here, since, sleep });
    } else {
      // Installed already: only a deploy that failed with something for you to fix is left to do.
      status = await run(r, repoReadStatus, { here });
      if (!needsYou(status)) return undefined;
    }
    const shown = needsYou(status) ? status : undefined;
    if (shown) for (const line of formatStatus(shown)) log(line);
    status = await fixInBrowser(runner(r), status, params);
    if (!status) {
      log(`No result after ${time.minutes(STATUS_TIMEOUT_MS)}. Run \`achq infra up\` to sync installs, then \`achq repo status\`.`);
      return { status };
    }
    if (status !== shown) for (const line of formatStatus(status)) log(line);
    return { status };
  },
});

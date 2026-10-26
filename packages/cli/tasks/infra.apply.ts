import { defineTask } from "@pokit/core";
import { known, plan, pluginsOf } from "@achq/core";
import { routerAdmin } from "@achq/core/clients/router";
import { context } from "@achq/core/context";
import { z } from "zod";
import { openInBrowser, readSecret } from "../io/terminal.ts";
import { planLines } from "../renderers/plan.ts";
import type { Npm } from "../io/npm.ts";
import { infraAwaitDeployer } from "./infra.await-deployer.ts";
import { infraCheckPlugins } from "./infra.check-plugins.ts";
import type { InfraResources } from "./infra.load.ts";
import { infraSync } from "./infra.sync.ts";
import { contextParams, given, type Open } from "./params.ts";
import { run, runner } from "./run.ts";

/**
 * Checks its plugins are on npm, plans the infra, shows the plan and applies
 * it, unless it's a dry run, then has the deployer sync every repo, once it
 * runs the version and plugins the plan gave it. Undefined, without a sync,
 * until the router exists.
 */
export const infraApply = defineTask({
  label: "Apply the infra",
  params: z.object({
    infra: given<InfraResources>(),
    prune: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    /** Replace the deployer's own token, where it has one. */
    rotateDeployerToken: z.boolean().default(false),
    /** What every container gets. */
    containerEnv: z.record(z.string(), z.string()),
    /** Where packages are looked up: npm, unless tests give another. */
    npm: given<Npm>().optional(),
    /** Opens `url` in your browser to `what`, e.g. to create an App. */
    open: given<Open>().default(() => openInBrowser),
    /** Asks you for a secret: by default at the terminal. */
    prompt: given<(message: string) => Promise<string>>().optional(),
    /** Rewrites the router's public URL for the sync; tests point it at a fake. */
    routerUrl: given<(publicUrl: string) => string>().optional(),
    ...contextParams,
  }),
  run: async (r, { params }) => {
    const { infra, prune, dryRun, rotateDeployerToken, containerEnv, npm, routerUrl, ...parts } = params;
    const { router, deployer, resources } = infra;
    const { log } = parts;
    const ctx = context({ ...parts, prompt: parts.prompt ?? ((message) => readSecret(runner(r).prompter, message)) });
    if (rotateDeployerToken) deployer.rotateToken();
    // What the router, deployer and containers install: checked before any of them is told to.
    const plugins = pluginsOf(resources);
    await run(r, infraCheckPlugins, { plugins: [...plugins.services, ...plugins.containers], core: deployer.version, npm });
    deployer.connect({ plugins, containerEnv, runtimes: infra.runtimes.map((runtime) => runtime.id) });

    const planned = await plan(resources, ctx);
    if (!planned.changes.length) log("  up to date");
    for (const line of planLines(planned)) log(`  ${line}`);

    // A dry run's key is known only if the router has it already: on some providers a new router's URL is known before it's made.
    const read = dryRun ? planned : await planned.apply();
    const url = read.value(router.url);
    const key = read.value(router.key);
    if (!known(url) || !known(key)) {
      log("  sync: skipped until the router exists");
      return undefined;
    }
    const admin = routerAdmin({ url: routerUrl ? routerUrl(url) : url, key });
    // A new deployer takes a while to replace the one running, and a sync the old one ran would deploy with what it was given.
    if (!dryRun) await run(r, infraAwaitDeployer, { admin, wanted: { version: deployer.version, plugins: plugins.services }, log, sleep: parts.sleep });
    return run(r, infraSync, { admin, request: { prune, dryRun }, sleep: parts.sleep });
  },
});

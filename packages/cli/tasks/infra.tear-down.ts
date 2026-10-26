import { defineTask } from "@pokit/core";
import { teardown } from "@achq/core";
import type { SyncRequest } from "@achq/core/protocol";
import { routerAdmin } from "@achq/core/clients/router";
import { context } from "@achq/core/context";
import { z } from "zod";
import { openInBrowser } from "../io/terminal.ts";
import { planLines } from "../renderers/plan.ts";
import { formatSync } from "../renderers/sync.ts";
import { foundRouter } from "./infra.find-router.ts";
import type { InfraResources } from "./infra.load.ts";
import { infraSync } from "./infra.sync.ts";
import { contextParams, given, type Open } from "./params.ts";
import { run } from "./run.ts";

/**
 * Deletes the infra: first the deployer syncs to no repos, uninstalling each
 * and deleting every container, then the router, the deployer and what they
 * share are deleted, each before what it depends on. Shows it all and asks
 * first, then deletes only what it showed. What's protected is listed and
 * left, and where you delete each yourself is opened.
 */
export const infraTearDown = defineTask({
  label: "Tear down the infra",
  params: z.object({
    infra: given<InfraResources>(),
    dryRun: z.boolean().default(false),
    /** Asks you whether to go ahead, once it's shown what it deletes. */
    confirm: given<(message: string) => Promise<boolean>>(),
    /** Opens `url` in your browser to `what`: where you delete what's protected yourself. */
    open: given<Open>().default(() => openInBrowser),
    /** Rewrites the router's public URL; tests point it at a fake. */
    routerUrl: given<(publicUrl: string) => string>().optional(),
    ...contextParams,
  }),
  run: async (r, { params }) => {
    const { infra, dryRun, confirm, open, routerUrl, ...parts } = params;
    const { log, sleep } = parts;
    // Teardown opens nothing itself: where you delete what's protected is opened once the rest is deleted.
    const ctx = context(parts);
    const found = await foundRouter(infra, ctx);
    const admin = found && routerAdmin({ url: routerUrl ? routerUrl(found.url) : found.url, key: found.key });
    const request: SyncRequest = { empty: true, prune: true };
    const synced = admin && (await run(r, infraSync, { admin, request: { ...request, dryRun: true }, sleep }));
    const planned = await teardown(infra.resources, ctx);
    const nothing = !planned.changes.length && !synced?.uninstalled.length && !synced?.pruned.length;
    if (nothing) log("  nothing to delete");
    // In the order it happens.
    if (synced && !nothing) for (const line of formatSync(synced, true)) log(`  sync: ${line}`);
    for (const line of planLines({ ...planned, warnings: [] })) log(`  ${line}`);
    if (dryRun) return;
    if (!nothing) {
      if (!(await confirm("Delete all of this?"))) throw new Error("Nothing was deleted");
      if (admin) for (const line of formatSync(await run(r, infraSync, { admin, request: { ...request, expect: synced!.pruned }, sleep }), false)) log(`  sync: ${line}`);
      await planned.apply();
      log("  deleted");
    }
    for (const { target, page } of planned.protected) if (page) await open(page, `delete ${target}`);
  },
});

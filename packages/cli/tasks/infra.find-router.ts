import { defineTask } from "@pokit/core";
import { type Context, known, plan } from "@achq/core";
import { context } from "@achq/core/context";
import { z } from "zod";
import type { InfraResources } from "./infra.load.ts";
import { contextParams, given } from "./params.ts";

/** What `routerAdmin` reaches the router with: its public URL and AGENT_WEBHOOK_KEY. */
export type RouterAccess = { url: string; key: string };

/**
 * The router's public URL and AGENT_WEBHOOK_KEY, read from where it runs, or
 * undefined if it hasn't both: its key is known only once it's set, and one
 * without it never reached the deployer, so nothing was deployed through it.
 * Plans the router, so changes nothing.
 */
export const foundRouter = async ({ router }: InfraResources, ctx: Context): Promise<RouterAccess | undefined> => {
  const planned = await plan([router], ctx);
  const url = planned.value(router.url);
  const key = planned.value(router.key);
  return known(key) && known(url) ? { url, key } : undefined;
};

/** The infra's router, as `achq infra status` and `replay` reach it, or an error saying to make it. */
export const infraFindRouter = defineTask({
  label: "Find the router",
  params: z.object({ infra: given<InfraResources>(), ...contextParams }),
  run: async (_r, { params: { infra, ...parts } }) => {
    const found = await foundRouter(infra, context(parts));
    if (!found) throw new Error(`There's no router ${infra.router.name}. Run \`achq infra up\`.`);
    return found;
  },
});

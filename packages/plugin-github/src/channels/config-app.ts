import type { RepoPlan } from "@achq/core";
import { maxLevel } from "../lib/permissions.ts";
import { PROVIDER } from "../lib/constants.ts";
import { CHANNEL, CONFIG_EVENTS, CONFIG_PERMISSIONS } from "./constants.ts";

/** The one App slug the config's policies and selectors name. */
export const configApp = (plan: RepoPlan) => {
  const slugs = new Set<string>();
  for (const { policy } of plan.policies) if (policy.provider === PROVIDER && typeof policy.app === "string") slugs.add(policy.app);
  const selectors = [...plan.workspaces.map((w) => w.threads), ...plan.triggers.map((t) => t.event)];
  for (const s of selectors) if (s.channel === CHANNEL && typeof s.source === "string") slugs.add(s.source);
  if (slugs.size !== 1) {
    throw new Error(slugs.size ? `The config names several Apps (${[...slugs].join(", ")}); achq install needs exactly one` : "The config names no GitHub App");
  }
  return [...slugs][0];
};

/** The events and permissions the config needs from its App. */
export const configNeeds = (plan: RepoPlan, slug: string) => {
  const events = new Set<string>(CONFIG_EVENTS);
  for (const t of plan.triggers) if (t.event.channel === CHANNEL && typeof t.event.event === "string") events.add(t.event.event);
  const permissions: Record<string, string> = { ...CONFIG_PERMISSIONS };
  const want = (name: string, level: string) => {
    permissions[name] = maxLevel(permissions[name], level);
  };
  // Replies go on the thread as the App.
  if (plan.workspaces.some((w) => w.threads.channel === CHANNEL)) want("issues", "write");
  for (const { policy } of plan.policies) {
    if (policy.provider !== PROVIDER || policy.app !== slug) continue;
    for (const [name, level] of Object.entries((policy.permissions ?? {}) as Record<string, string>)) want(name, level);
  }
  return { events: [...events].sort(), permissions };
};

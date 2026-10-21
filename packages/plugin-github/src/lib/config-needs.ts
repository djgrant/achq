import type { RepoManifest } from "@achq/core";
import { CHANNEL, POLICY_PROVIDER } from "./constants.ts";
import { CONFIG_EVENTS, CONFIG_PERMISSIONS, maxLevel } from "./permissions.ts";

export const configSource = (manifest: RepoManifest) => {
  const slugs = new Set<string>();
  for (const { policy } of manifest.policies) if (policy.provider === POLICY_PROVIDER && policy.source) slugs.add(policy.source);
  const selectors = [...manifest.workspaces.map((w) => w.threads), ...manifest.triggers.map((t) => t.event)];
  for (const s of selectors) if (s.channel === CHANNEL) slugs.add(s.source);
  if (slugs.size !== 1) {
    throw new Error(slugs.size ? `The config names several Apps (${[...slugs].join(", ")}); achq repo install needs exactly one` : "The config names no GitHub App");
  }
  return [...slugs][0];
};

export const configNeeds = (manifest: RepoManifest, slug: string) => {
  const events = new Set<string>(CONFIG_EVENTS);
  for (const t of manifest.triggers) if (t.event.channel === CHANNEL && typeof t.event.event === "string") events.add(t.event.event);
  const permissions = { ...CONFIG_PERMISSIONS };
  const want = (name: string, level: string) => {
    permissions[name] = maxLevel(permissions[name], level);
  };
  // Replies go on the thread as the App.
  if (manifest.workspaces.some((w) => w.threads.channel === CHANNEL)) want("issues", "write");
  for (const { policy } of manifest.policies) {
    if (policy.provider !== POLICY_PROVIDER || policy.source !== slug) continue;
    for (const [name, level] of Object.entries((policy.permissions ?? {}) as Record<string, string>)) want(name, level);
  }
  return { events: [...events].sort(), permissions };
};

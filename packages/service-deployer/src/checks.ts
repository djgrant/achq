import type { ConfigTree, RepoPlan, SourceSettings } from "@achq/core";
import { normaliseRepoPath } from "./config/index.ts";

/** The checks in "Checks" and "Subscribing" that need nothing but the plan, the tree and the router's sources. */
export const checkPlan = (plan: RepoPlan, ctx: { source: string; tree: ConfigTree; sources: SourceSettings[] }) => {
  const failures: string[] = [];
  const warnings: string[] = [];
  /** A policy names only its source, so any channel's will do for it. */
  const known = (channel: string | undefined, source: string) => ctx.sources.find((s) => (!channel || s.channel === channel) && s.source === source);

  const named: { what: string; channel?: string; source?: string }[] = [
    ...plan.policies.map((p) => ({ what: `policy ${p.name}`, source: p.policy.source })),
    ...plan.workspaces.map((w) => ({ what: `workspace ${w.name}`, channel: w.threads.channel, source: w.threads.source })),
    ...plan.triggers.map((t) => ({ what: `trigger ${t.name}`, channel: t.event.channel, source: t.event.source })),
  ];
  for (const n of named) {
    if (typeof n.source !== "string" || !n.source) failures.push(`${n.what} names no source`);
    else if (!known(n.channel, n.source)) failures.push(`${n.what} names ${n.channel ? `${n.channel}:` : ""}${n.source}, which the router doesn't know`);
  }
  const usesInstalled = plan.policies.some((p) => p.policy.source === ctx.source) || plan.workspaces.some((w) => w.threads.source === ctx.source);
  if (!usesInstalled) failures.push(`no policy or workspace names ${ctx.source}, the source that was installed`);

  for (const c of plan.containers) {
    const path = normaliseRepoPath(c.image);
    if (!path) failures.push(`container ${c.name}'s image "${c.image}" isn't a path under .achq/`);
    else if (!ctx.tree.blobs.has(path)) failures.push(`container ${c.name}'s image .achq/${path} doesn't exist`);
  }

  for (const t of plan.triggers) {
    const settings = known(t.event.channel, t.event.source);
    const event = t.event.event;
    if (settings && typeof event === "string" && !settings.events.includes(event))
      failures.push(`trigger ${t.name} wants ${event}, which ${settings.source} doesn't send`);
    const covered = plan.workspaces.some((w) => w.threads.channel === t.event.channel && w.threads.source === t.event.source);
    if (!covered) warnings.push(`trigger ${t.name} never runs: no workspace's threads come from ${t.event.channel}:${t.event.source}`);
  }
  return { failures, warnings };
};

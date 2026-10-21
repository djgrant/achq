import type { ConfigTree, RepoManifest, SourceSettings } from "@achq/core";
import { CONFIG_DIR, normaliseRepoPath } from "./config/evaluate.ts";

/** A policy names only its source, so with no channel any channel's will do. */
const findSource = (sources: SourceSettings[], channel: string | undefined, source: string) =>
  sources.find((s) => (!channel || s.channel === channel) && s.source === source);

/** A container's Dockerfile as the container provider takes it, under `.achq/`, and as the tree keys it, relative to `.achq/`. */
export const dockerfileOf = (c: RepoManifest["containers"][number]) => {
  const path = normaliseRepoPath(c.image);
  return path ? { dockerfile: `${CONFIG_DIR}/${path}`, path } : undefined;
};

/** What stops a deploy, and what only warns. */
export const checkManifest = (manifest: RepoManifest, { tree, sources }: { tree: ConfigTree; sources: SourceSettings[] }) => {
  const failures: string[] = [];
  const warnings: string[] = [];

  const references: { what: string; channel?: string; source?: string }[] = [
    ...manifest.policies.map((p) => ({ what: `policy ${p.name}`, source: p.policy.source })),
    ...manifest.workspaces.map((w) => ({ what: `workspace ${w.name}`, channel: w.threads.channel, source: w.threads.source })),
    ...manifest.triggers.map((t) => ({ what: `trigger ${t.name}`, channel: t.event.channel, source: t.event.source })),
  ];
  for (const { what, channel, source } of references) {
    if (typeof source !== "string" || !source) failures.push(`${what} names no source`);
    else if (!findSource(sources, channel, source)) failures.push(`${what} names ${channel ? `${channel}:` : ""}${source}, which the router doesn't know`);
  }

  for (const c of manifest.containers) {
    const image = dockerfileOf(c);
    if (!image) failures.push(`container ${c.name}'s image "${c.image}" isn't a path under ${CONFIG_DIR}/`);
    else if (!tree.blobs.has(image.path)) failures.push(`container ${c.name}'s image ${image.dockerfile} doesn't exist`);
  }

  // A trigger's event must be one its source sends. A trigger no workspace's threads come from never runs, which is only a warning.
  for (const t of manifest.triggers) {
    const settings = findSource(sources, t.event.channel, t.event.source);
    const { event } = t.event;
    if (settings && typeof event === "string" && !settings.events.includes(event)) failures.push(`trigger ${t.name} wants ${event}, which ${settings.source} doesn't send`);
    if (!manifest.workspaces.some((w) => w.threads.channel === t.event.channel && w.threads.source === t.event.source))
      warnings.push(`trigger ${t.name} never runs: no workspace's threads come from ${t.event.channel}:${t.event.source}`);
  }

  return { failures, warnings };
};

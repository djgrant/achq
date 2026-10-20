// The checks in "Checks" (docs/achq-design.md) that need nothing but the
// manifest, the tree and the router's sources.
import type { ConfigTree, RepoManifest, SourceSettings } from "@achq/core";
import { normaliseRepoPath } from "./config/index.ts";
import { CONFIG_DIR } from "./constants.ts";

type Container = RepoManifest["containers"][number];
type Trigger = RepoManifest["triggers"][number];

type SourceReference = { what: string; channel?: string; source?: string };

/** A policy names only its source, so with no channel any channel's will do. */
const findSource = (sources: SourceSettings[], channel: string | undefined, source: string) =>
  sources.find((s) => (!channel || s.channel === channel) && s.source === source);

const sourceReferences = (manifest: RepoManifest): SourceReference[] => [
  ...manifest.policies.map((p) => ({ what: `policy ${p.name}`, source: p.policy.source })),
  ...manifest.workspaces.map((w) => ({ what: `workspace ${w.name}`, channel: w.threads.channel, source: w.threads.source })),
  ...manifest.triggers.map((t) => ({ what: `trigger ${t.name}`, channel: t.event.channel, source: t.event.source })),
];

/** A container's Dockerfile as the container provider takes it, under `.achq/`, and as the tree keys it, relative to `.achq/`. */
export const dockerfileOf = (c: Container): { dockerfile: string; path: string } | undefined => {
  const path = normaliseRepoPath(c.image);
  return path ? { dockerfile: `${CONFIG_DIR}/${path}`, path } : undefined;
};

const checkSourcesKnown = (manifest: RepoManifest, sources: SourceSettings[]) =>
  sourceReferences(manifest).flatMap(({ what, channel, source }) => {
    if (typeof source !== "string" || !source) return [`${what} names no source`];
    if (!findSource(sources, channel, source)) return [`${what} names ${channel ? `${channel}:` : ""}${source}, which the router doesn't know`];
    return [];
  });

const checkImagesExist = (manifest: RepoManifest, tree: ConfigTree) =>
  manifest.containers.flatMap((c) => {
    const image = dockerfileOf(c);
    if (!image) return [`container ${c.name}'s image "${c.image}" isn't a path under ${CONFIG_DIR}/`];
    if (!tree.blobs.has(image.path)) return [`container ${c.name}'s image ${image.dockerfile} doesn't exist`];
    return [];
  });

/** Whether some workspace's threads come from the trigger's source, so the trigger can ever run. */
const isCovered = (manifest: RepoManifest, t: Trigger) =>
  manifest.workspaces.some((w) => w.threads.channel === t.event.channel && w.threads.source === t.event.source);

/** A trigger's event must be one its source sends; a trigger no workspace can run is only a warning. */
const checkTriggers = (manifest: RepoManifest, sources: SourceSettings[]) => {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const t of manifest.triggers) {
    const settings = findSource(sources, t.event.channel, t.event.source);
    const { event } = t.event;
    if (settings && typeof event === "string" && !settings.events.includes(event))
      failures.push(`trigger ${t.name} wants ${event}, which ${settings.source} doesn't send`);
    if (!isCovered(manifest, t)) warnings.push(`trigger ${t.name} never runs: no workspace's threads come from ${t.event.channel}:${t.event.source}`);
  }
  return { failures, warnings };
};

export const checkManifest = (manifest: RepoManifest, ctx: { tree: ConfigTree; sources: SourceSettings[] }) => {
  const triggers = checkTriggers(manifest, ctx.sources);
  const failures = [...checkSourcesKnown(manifest, ctx.sources), ...checkImagesExist(manifest, ctx.tree), ...triggers.failures];
  return { failures, warnings: triggers.warnings };
};

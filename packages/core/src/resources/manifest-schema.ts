import { collections } from "@achq/utils/collections";
import type { Json } from "@achq/utils/json";
import { z } from "zod";
import { type RepoManifest, undeclaredRef } from "./repo-manifest.ts";
import { RESOURCE_NAME } from "./resource.ts";

/*
 * Kept out of @achq/core's index, so what runs in the config sandbox doesn't
 * load zod: the checks run on what the sandbox returns, outside it.
 */

const name = z.string().regex(RESOURCE_NAME, "must be lowercase letters, digits and dashes, starting with a letter");
const text = z.string().max(10_000);

const data: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string().max(100_000), z.number().refine(Number.isFinite), z.boolean(), z.null(), z.array(data).max(10_000), z.record(z.string(), data)]),
);

/** JSON with a non-empty string under `key`: a selector's `channel`, a policy's `provider`. */
type Tagged<K extends string> = { [P in K]: string } & { [key: string]: Json };

const MAX_TAG_LENGTH = 100;

/** zod can't express "this key is a string, the rest any data", so the refinement's guarantee is asserted in the type. */
const tagged = <K extends string>(key: K) =>
  z.record(z.string(), data).refine((r) => {
    const tag = r[key];
    return typeof tag === "string" && tag.length > 0 && tag.length <= MAX_TAG_LENGTH;
  }, `needs "${key}"`) as unknown as z.ZodType<Tagged<K>>;

const selector = tagged("channel");
const policyData = tagged("provider");

const manifestSchema = z.strictObject({
  policies: z.array(z.strictObject({ name, policy: policyData })).max(100),
  containers: z.array(z.strictObject({ name, image: text, policies: z.array(name).max(100), files: z.record(z.string().max(1000), data) })).max(20),
  workspaces: z.array(z.strictObject({ name, container: name, threads: selector, branch: text, base: text })).max(100),
  agents: z.array(z.strictObject({ name, runtime: z.string().min(1).max(100) })).max(100),
  triggers: z.array(z.strictObject({ name, event: selector, agent: name })).max(100),
});

type Named = { name: string };

const KINDS = ["policies", "containers", "workspaces", "agents", "triggers"] as const;

const assertRefs = <T extends Named>(items: T[], from: string, refsOf: (item: T) => string[], targets: Named[], kind: string) => {
  const known = new Set(targets.map((t) => t.name));
  for (const item of items) for (const ref of refsOf(item)) if (!known.has(ref)) throw undeclaredRef(`${from} ${item.name}`, kind, ref);
};

/**
 * Checks a manifest: its shape, sizes, names unique per kind, references to
 * what's declared, and at least one container. Strict, because a sandboxed
 * config can monkeypatch anything there, collectManifest included, and forge
 * what comes back.
 */
export const validateManifest = (value: unknown): RepoManifest => {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`The config's manifest is invalid at ${issue.path.join(".") || "the top level"}: ${issue.message}`);
  }
  const manifest = parsed.data as RepoManifest;
  for (const kinds of KINDS) {
    const [repeated] = collections.duplicates(manifest[kinds].map((r) => r.name));
    if (repeated !== undefined) throw new Error(`Two ${kinds} are named "${repeated}"`);
  }
  assertRefs(manifest.containers, "container", (c) => c.policies, manifest.policies, "policy");
  assertRefs(manifest.workspaces, "workspace", (w) => [w.container], manifest.containers, "container");
  assertRefs(manifest.triggers, "trigger", (t) => [t.agent], manifest.agents, "agent");
  if (!manifest.containers.length) throw new Error("The config declares no containers");
  return manifest;
};

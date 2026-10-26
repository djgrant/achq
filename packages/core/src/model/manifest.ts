import { collections } from "@achq/utils/collections";
import { json, type Json } from "@achq/utils/json";
import { z } from "zod";
import { type ManifestInput as ManifestInputType, type PolicyData, RESOURCE_NAME, type RepoManifest as RepoManifestType, type SelectorData, undeclaredRef } from "./resource-data.ts";

/*
 * Kept out of @achq/core's index, so what runs in the config sandbox doesn't
 * load zod: the checks run on what the sandbox returns, outside it.
 */

/** Selector and policy data in what another version of achq wrote: checked only for what names its channel or policy provider. */
export const policyData = z.custom<PolicyData>((value) => json.isPlainObject(value) && typeof value.provider === "string");
export const selectorData = z.custom<SelectorData>((value) => json.isPlainObject(value) && typeof value.channel === "string" && typeof value.source === "string");

/** What the manifest's shape is made of, in one of its two roles: how its objects treat unknown keys, and its parts with or without limits. */
type Parts<C extends z.core.$ZodObjectConfig> = {
  object: <S extends z.core.$ZodLooseShape>(shape: S) => z.ZodObject<S, C>;
  list: <T extends z.ZodType>(item: T, max: number) => z.ZodArray<T>;
  name: z.ZodType<string>;
  text: z.ZodType<string>;
  key: z.ZodType<string>;
  runtime: z.ZodType<string>;
  data: z.ZodType<Json>;
  selector: z.ZodType<SelectorData>;
  policy: z.ZodType<PolicyData>;
};

/** The manifest's shape (resource-data.ts's ManifestInput and RepoManifest), written once for both roles, so they can't drift. */
const manifestShape = <C extends z.core.$ZodObjectConfig>({ object, list, name, text, key, runtime, data, selector, policy }: Parts<C>) =>
  object({
    policies: list(object({ name, policy }), 100),
    containers: list(object({ name, image: text, policies: list(name, 100), files: z.record(key, data) }), 20),
    workspaces: list(object({ name, container: name, threads: selector, branch: text, base: text }), 100),
    agents: list(object({ name, runtime }), 100),
    triggers: list(object({ name, event: selector, agent: name }), 100),
  });

const limitedData: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string().max(100_000), z.number().refine(Number.isFinite), z.boolean(), z.null(), z.array(limitedData).max(10_000), z.record(z.string(), limitedData)]),
);

const MAX_TAG_LENGTH = 100;

/**
 * Data with a non-empty string under `key`: a selector's `channel`, a policy's
 * `provider`. zod can't express "this key is a string, the rest any data", so
 * the refinement's guarantee is asserted in the type.
 */
const tagged = <T>(key: string) =>
  z.record(z.string(), limitedData).refine((r) => {
    const tag = r[key];
    return typeof tag === "string" && tag.length > 0 && tag.length <= MAX_TAG_LENGTH;
  }, `needs "${key}"`) as unknown as z.ZodType<T>;

/** The manifest as the deployer evaluates it from `.achq/`: what a person wrote, so strict and limited. */
export const ManifestInput = manifestShape({
  object: z.strictObject,
  list: (item, max) => z.array(item).max(max),
  name: z.string().regex(RESOURCE_NAME, "must be lowercase letters, digits and dashes, starting with a letter"),
  text: z.string().max(10_000),
  key: z.string().max(1000),
  runtime: z.string().min(1).max(100),
  data: limitedData,
  selector: tagged<SelectorData>("channel"),
  policy: tagged<PolicyData>("provider"),
}) satisfies z.ZodType<ManifestInputType>;
export type ManifestInput = ManifestInputType;

/** The manifest as another version of achq kept it, e.g. in `StoredRecord.deployed`: loose, without limits. */
export const RepoManifest = manifestShape({
  object: z.looseObject,
  list: (item) => z.array(item),
  name: z.string(),
  text: z.string(),
  key: z.string(),
  runtime: z.string(),
  data: z.json() as z.ZodType<Json>,
  selector: selectorData,
  policy: policyData,
}) satisfies z.ZodType<RepoManifestType>;
export type RepoManifest = RepoManifestType;

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
export const validateManifest = (value: unknown) => {
  const parsed = ManifestInput.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`The config's manifest is invalid at ${issue.path.join(".") || "the top level"}: ${issue.message}`);
  }
  const manifest = parsed.data;
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

import { collections } from "@achq/utils/collections";
import { json, type Json } from "@achq/utils/json";
import { schema } from "@achq/utils/schema";
import * as v from "valibot";
import { type ManifestInput as ManifestInputType, type PolicyData, RESOURCE_NAME, type RepoManifest as RepoManifestType, type SelectorData, undeclaredRef } from "./resource-data.ts";

/*
 * Kept out of @achq/core's index, so what runs in the config sandbox doesn't
 * load the schemas: the checks run on what the sandbox returns, outside it.
 */

/** Selector and policy data in what another version of achq wrote: checked only for what names its channel or policy provider. */
export const policyData = v.custom<PolicyData>((value) => json.isPlainObject(value) && typeof value.provider === "string");
export const selectorData = v.custom<SelectorData>((value) => json.isPlainObject(value) && typeof value.channel === "string" && typeof value.source === "string");

/** What the manifest's shape is made of, in one of its two roles: how its objects treat unknown keys, and its parts with or without limits. */
type Parts = {
  object: (entries: v.ObjectEntries) => v.GenericSchema;
  list: (item: v.GenericSchema, max: number) => v.GenericSchema;
  name: v.GenericSchema<string>;
  text: v.GenericSchema<string>;
  key: v.GenericSchema<string>;
  runtime: v.GenericSchema<string>;
  data: v.GenericSchema<Json>;
  selector: v.GenericSchema<SelectorData>;
  policy: v.GenericSchema<PolicyData>;
};

/**
 * The manifest's shape, written once for both roles, so they can't drift. A
 * role's objects can't be generic over their entries, so it's typed as the
 * role reads it: resource-data.ts's ManifestInput or RepoManifest.
 */
const manifestShape = <M>({ object, list, name, text, key, runtime, data, selector, policy }: Parts) =>
  object({
    policies: list(object({ name, policy }), 100),
    containers: list(object({ name, image: text, policies: list(name, 100), files: v.record(key, data) }), 20),
    workspaces: list(object({ name, container: name, threads: selector, branch: text, base: text }), 100),
    agents: list(object({ name, runtime }), 100),
    triggers: list(object({ name, event: selector, agent: name }), 100),
  }) as v.GenericSchema<unknown, M>;

const limitedData: v.GenericSchema<Json> = v.lazy(() =>
  v.union([
    v.pipe(v.string(), v.maxLength(100_000)),
    v.pipe(v.number(), v.finite()),
    v.boolean(),
    v.null(),
    v.pipe(v.array(limitedData), v.maxLength(10_000)),
    v.record(v.string(), limitedData),
  ]),
);

const MAX_TAG_LENGTH = 100;

/**
 * Data with a non-empty string under `key`: a selector's `channel`, a policy's
 * `provider`. A record can't say "this key is a string, the rest any data", so
 * the check's guarantee is asserted in the type.
 */
const tagged = <T>(key: string) =>
  v.pipe(
    v.record(v.string(), limitedData),
    v.check((r) => {
      const tag = r[key];
      return typeof tag === "string" && tag.length > 0 && tag.length <= MAX_TAG_LENGTH;
    }, `needs "${key}"`),
  ) as unknown as v.GenericSchema<T>;

/** The manifest as the deployer evaluates it from `.achq/`: what a person wrote, so strict and limited. */
export const ManifestInput = manifestShape<ManifestInputType>({
  object: v.strictObject,
  list: (item, max) => v.pipe(v.array(item), v.maxLength(max)),
  name: v.pipe(v.string(), v.regex(RESOURCE_NAME, "must be lowercase letters, digits and dashes, starting with a letter")),
  text: v.pipe(v.string(), v.maxLength(10_000)),
  key: v.pipe(v.string(), v.maxLength(1000)),
  runtime: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  data: limitedData,
  selector: tagged<SelectorData>("channel"),
  policy: tagged<PolicyData>("provider"),
});
export type ManifestInput = ManifestInputType;

/** The manifest as another version of achq kept it, e.g. in `StoredRecord.deployed`: loose, without limits. */
export const RepoManifest = manifestShape<RepoManifestType>({
  object: v.looseObject,
  list: (item) => v.array(item),
  name: v.string(),
  text: v.string(),
  key: v.string(),
  runtime: v.string(),
  data: schema.json,
  selector: selectorData,
  policy: policyData,
});
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
  const parsed = v.safeParse(ManifestInput, value);
  if (!parsed.success) {
    const issue = parsed.issues[0]!;
    throw new Error(`The config's manifest is invalid at ${v.getDotPath(issue) || "the top level"}: ${issue.message}`);
  }
  const manifest = parsed.output;
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

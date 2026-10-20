// The manifest is untrusted. A config can monkeypatch anything inside the sandbox,
// including collectManifest, so the manifest's shape and references are checked again
// here, strictly.
import { z } from "zod";
import { type Data, RESOURCE_NAME, type RepoManifest } from "@achq/core";
import { duplicates } from "@achq/utils/collections";

const name = z.string().regex(RESOURCE_NAME, "must be lowercase letters, digits and dashes, starting with a letter");
const text = z.string().max(10_000);

const data: z.ZodType<Data> = z.lazy(() =>
  z.union([z.string().max(100_000), z.number().refine(Number.isFinite), z.boolean(), z.null(), z.array(data).max(10_000), z.record(z.string(), data)]),
);

/** Data with a non-empty string under `key`: a selector's `channel`, a policy's `provider`. */
type Tagged<K extends string> = { [P in K]: string } & { [key: string]: Data };

const MAX_TAG_LENGTH = 100;

const hasTag = (record: Record<string, Data>, key: string) => {
  const tag = record[key];
  return typeof tag === "string" && tag.length > 0 && tag.length <= MAX_TAG_LENGTH;
};

/** zod can't express "this key is a string, the rest any data", so the refinement's guarantee is asserted in the type. */
const tagged = <K extends string>(key: K) => z.record(z.string(), data).refine((r) => hasTag(r, key), `needs "${key}"`) as unknown as z.ZodType<Tagged<K>>;

const selector = tagged("channel");
const policyData = tagged("provider");

const manifestSchema = z.strictObject({
  policies: z.array(z.strictObject({ name, policy: policyData })).max(100),
  containers: z.array(z.strictObject({ name, image: text, policies: z.array(name).max(100), files: z.record(z.string().max(1000), data) })).min(1).max(20),
  workspaces: z.array(z.strictObject({ name, container: name, threads: selector, branch: text, base: text })).max(100),
  agents: z.array(z.strictObject({ name, runtime: z.string().min(1).max(100) })).max(100),
  triggers: z.array(z.strictObject({ name, event: selector, agent: name })).max(100),
});

type Named = { name: string };

const KINDS = ["policies", "containers", "workspaces", "agents", "triggers"] as const;

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("The config's manifest isn't valid JSON");
  }
};

const assertNamesUnique = (manifest: RepoManifest) => {
  for (const kind of KINDS) {
    const [repeated] = duplicates(manifest[kind].map((r) => r.name));
    if (repeated !== undefined) throw new Error(`The config's manifest has two ${kind} named "${repeated}"`);
  }
};

const assertRefs = <T extends Named>(items: T[], label: string, refsOf: (item: T) => string[], targets: Named[], kind: string) => {
  const known = new Set(targets.map((t) => t.name));
  for (const item of items)
    for (const ref of refsOf(item)) if (!known.has(ref)) throw new Error(`${label} ${item.name} refers to ${kind} "${ref}", which isn't in the manifest`);
};

export const parseManifest = (json: string): RepoManifest => {
  const parsed = manifestSchema.safeParse(parseJson(json));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`The config's manifest is invalid at ${issue.path.join(".") || "the top level"}: ${issue.message}`);
  }
  const manifest = parsed.data as RepoManifest;
  assertNamesUnique(manifest);
  assertRefs(manifest.containers, "Container", (c) => c.policies, manifest.policies, "policy");
  assertRefs(manifest.workspaces, "Workspace", (w) => [w.container], manifest.containers, "container");
  assertRefs(manifest.triggers, "Trigger", (t) => [t.agent], manifest.agents, "agent");
  return manifest;
};

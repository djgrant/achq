// The manifest is untrusted. A config can monkeypatch anything inside the sandbox,
// including collectManifest, so the manifest's shape and references are checked again
// here, strictly.
import { z } from "zod";
import { type Data, RESOURCE_NAME, type RepoManifest } from "@achq/core";

const name = z.string().regex(RESOURCE_NAME, "must be lowercase letters, digits and dashes, starting with a letter");
const text = z.string().max(10_000);

const data: z.ZodType<Data> = z.lazy(() =>
  z.union([z.string().max(100_000), z.number().refine(Number.isFinite), z.boolean(), z.null(), z.array(data).max(10_000), z.record(z.string(), data)]),
);
const tagged = <K extends string>(key: K) =>
  z
    .record(z.string(), data)
    .refine((r) => typeof r[key] === "string" && (r[key] as string).length > 0 && (r[key] as string).length <= 100, `needs "${key}"`) as unknown as z.ZodType<
    { [P in K]: string } & { [key: string]: Data }
  >;
const selector = tagged("channel");
const policyData = tagged("provider");

const manifestSchema = z.strictObject({
  policies: z.array(z.strictObject({ name, policy: policyData })).max(100),
  containers: z.array(z.strictObject({ name, image: text, policies: z.array(name).max(100), files: z.record(z.string().max(1000), data) })).min(1).max(20),
  workspaces: z.array(z.strictObject({ name, container: name, threads: selector, branch: text, base: text })).max(100),
  agents: z.array(z.strictObject({ name, runtime: z.string().min(1).max(100) })).max(100),
  triggers: z.array(z.strictObject({ name, event: selector, agent: name })).max(100),
});

export const parseManifest = (json: string): RepoManifest => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("The config's manifest isn't valid JSON");
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`The config's manifest is invalid at ${issue.path.join(".") || "the top level"}: ${issue.message}`);
  }
  const manifest = parsed.data as RepoManifest;
  for (const kind of ["policies", "containers", "workspaces", "agents", "triggers"] as const) {
    const names = manifest[kind].map((r) => r.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new Error(`The config's manifest has two ${kind} named "${dup}"`);
  }
  const has = (list: { name: string }[], n: string) => list.some((r) => r.name === n);
  for (const c of manifest.containers)
    for (const p of c.policies) if (!has(manifest.policies, p)) throw new Error(`Container ${c.name} refers to policy "${p}", which isn't in the manifest`);
  for (const w of manifest.workspaces) if (!has(manifest.containers, w.container)) throw new Error(`Workspace ${w.name} refers to container "${w.container}", which isn't in the manifest`);
  for (const t of manifest.triggers) if (!has(manifest.agents, t.agent)) throw new Error(`Trigger ${t.name} refers to agent "${t.agent}", which isn't in the manifest`);
  return manifest;
};

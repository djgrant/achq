import type { Json } from "@achq/utils/json";

/*
 * How resources appear as plain data: in a manifest, in what the router keeps
 * and forwards, and to the providers that interpret it.
 */

/** What a resource's name may be. */
export const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Selector and policy data always says which channel or policy provider interprets it. */
export type SelectorData = { channel: string; source: string; [key: string]: Json };
/**
 * `source`, when present, is the channel source the policy grants through, e.g. a GitHub App.
 * A repo's config always names one; the deployer's own policy leaves it to the policy provider.
 */
export type PolicyData = { provider: string; [key: string]: Json } & { source?: string };

/**
 * What a repo's config evaluates to: every resource as plain data. Resources
 * refer to each other by name. Arrays keep declaration order, which decides
 * which workspace claims a thread. `Extra` is what else each object may have:
 * nothing in what a person wrote, anything in what another version of achq kept.
 */
type Manifest<Extra> = Extra & {
  policies: (Extra & { name: string; policy: PolicyData })[];
  containers: (Extra & { name: string; image: string; policies: string[]; files: Record<string, Json> })[];
  workspaces: (Extra & { name: string; container: string; threads: SelectorData; branch: string; base: string })[];
  agents: (Extra & { name: string; runtime: string })[];
  triggers: (Extra & { name: string; event: SelectorData; agent: string })[];
};

/** The manifest as the deployer evaluates it from `.achq/`: what a person wrote, so strict. */
export type ManifestInput = Manifest<{}>;

/** The manifest as another version of achq kept it, e.g. in `StoredRecord.deployed`: loose. */
export type RepoManifest = Manifest<{ [key: string]: unknown }>;

/** The error for `from` referring to a `kind` named `ref` that the config doesn't declare. */
export const undeclaredRef = (from: string, kind: string, ref: string) => new Error(`${from} refers to ${kind} "${ref}", which isn't declared in this config`);

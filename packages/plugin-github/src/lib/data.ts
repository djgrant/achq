import type { POLICY_PROVIDER } from "./constants.ts";

// What schemas.ts parses, as plain types: resources and their declarations use these, without zod.

/** ACHQ_GITHUB_APPS: each App's key, by slug. */
export type AppKeys = Record<string, { id: string; privateKey: string }>;

export type Permission = "read" | "write";

export type GitHubPolicyData = {
  provider: typeof POLICY_PROVIDER;
  /** Without one, whichever App is installed on the repo. */
  source?: string;
  /** Null for the repo the config is in. */
  repo?: string | null;
  permissions: Record<string, Permission>;
};

import { z } from "zod";
import { POLICY_PROVIDER, REPO } from "./constants.ts";

/** An App's key: ACHQ_GITHUB_APPS may give its id as a number. */
export const AppKey = z.object({ id: z.union([z.string(), z.number()]).transform(String), privateKey: z.string() });

/** ACHQ_GITHUB_APPS: each App's key, by slug. */
export const AppKeys = z.record(z.string(), AppKey);
export type AppKeys = z.infer<typeof AppKeys>;

export const Permission = z.enum(["read", "write"]);
export type Permission = z.infer<typeof Permission>;

export const GitHubPolicyData = z.object({
  provider: z.literal(POLICY_PROVIDER),
  /** Without one, whichever App is installed on the repo. */
  source: z.string().optional(),
  /** Null for the repo the config is in. */
  repo: z.string().regex(REPO).nullish(),
  permissions: z.record(z.string(), Permission).default({}),
});
export type GitHubPolicyData = z.infer<typeof GitHubPolicyData>;

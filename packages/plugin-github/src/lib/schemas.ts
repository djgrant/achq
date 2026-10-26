import { repoName } from "@achq/core";
import { z } from "zod";
import { POLICY_PROVIDER } from "./constants.ts";
import type * as data from "./data.ts";

// Each schema satisfies data.ts's plain type.

/** An App's key: ACHQ_GITHUB_APPS may give its id as a number. */
export const AppKey = z.object({ id: z.union([z.string(), z.number()]).transform(String), privateKey: z.string() });

/** ACHQ_GITHUB_APPS: each App's key, by slug. */
export const AppKeys = z.record(z.string(), AppKey) satisfies z.ZodType<data.AppKeys>;
export type AppKeys = data.AppKeys;

export const Permission = z.enum(["read", "write"]) satisfies z.ZodType<data.Permission>;
export type Permission = data.Permission;

export const GitHubPolicyData = z.object({
  provider: z.literal(POLICY_PROVIDER),
  source: z.string().optional(),
  repo: z.string().regex(repoName.pattern).nullish(),
  permissions: z.record(z.string(), Permission).default({}),
}) satisfies z.ZodType<data.GitHubPolicyData>;
export type GitHubPolicyData = data.GitHubPolicyData;

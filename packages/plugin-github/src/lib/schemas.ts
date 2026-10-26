import { repoName } from "@achq/core";
import { type Reads } from "@achq/utils/schema";
import * as v from "valibot";
import { POLICY_PROVIDER } from "./constants.ts";
import type * as data from "./data.ts";

// Each schema satisfies data.ts's plain type.

/** An App's key: ACHQ_GITHUB_APPS may give its id as a number. */
export const AppKey = v.object({ id: v.pipe(v.union([v.string(), v.number()]), v.transform(String)), privateKey: v.string() });

/** ACHQ_GITHUB_APPS: each App's key, by slug. */
export const AppKeys = v.record(v.string(), AppKey) satisfies Reads<data.AppKeys>;
export type AppKeys = data.AppKeys;

export const Permission = v.picklist(["read", "write"]) satisfies Reads<data.Permission>;
export type Permission = data.Permission;

export const GitHubPolicyData = v.object({
  provider: v.literal(POLICY_PROVIDER),
  source: v.optional(v.string()),
  repo: v.nullish(v.pipe(v.string(), v.regex(repoName.pattern))),
  permissions: v.optional(v.record(v.string(), Permission), {}),
}) satisfies Reads<data.GitHubPolicyData>;
export type GitHubPolicyData = data.GitHubPolicyData;

import type { PolicyData } from "@achq/core";

/** `repo: null` means the config's own repo. */
export const resolvePolicy = (policy: PolicyData, repo: string): PolicyData => ("repo" in policy && policy.repo === null ? { ...policy, repo } : policy);

/** The source (App slug) a policy is for: GitHub policies name it as `app`. */
export const policySource = (policy: PolicyData) => (typeof policy.app === "string" ? policy.app : typeof policy.source === "string" ? policy.source : undefined);

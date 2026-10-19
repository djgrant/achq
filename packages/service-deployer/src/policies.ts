import type { PolicyData } from "@achq/core";

/** `repo: null` means the config's own repo. */
export const resolvePolicy = (policy: PolicyData, repo: string): PolicyData => ("repo" in policy && policy.repo === null ? { ...policy, repo } : policy);


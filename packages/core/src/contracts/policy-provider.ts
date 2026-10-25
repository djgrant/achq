import type { PolicyCredential } from "../model/credentials.ts";
import type { PolicyData } from "../model/resource-data.ts";

/**
 * Turns policies into credentials. The router and container load the same code,
 * and each calls its own part. Only the router's instance has the secrets.
 * Comes from achq or the infra repo, never a subscriber repo.
 */
export interface PolicyProvider {
  readonly id: string;
  /** Router: problems with a policy for `repo`, empty if fine. */
  validate(policy: PolicyData, repo: string): Promise<string[]>;
  /** Router: credentials covering `policies`, for a container in `repo`. */
  mint(policies: PolicyData[], repo: string): Promise<PolicyCredential[]>;
  /** Container: makes credentials usable by agents (files under `dir`, env). Called again on refresh. */
  install(credentials: PolicyCredential[], dir: string): Promise<{ env: Record<string, string> }>;
}

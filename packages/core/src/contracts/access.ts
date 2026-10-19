import type { PolicyData } from "../resources/config.ts";
import type { Credential } from "./channel.ts";

/** For agents: minted by the access provider it names. */
export type AccessCredential = Credential & { access: string };

/**
 * Turns policies into credentials. The router and container load the same code,
 * and each calls its own part. Only the router's instance has the secrets.
 * Comes from achq or the infra repo, never a subscriber repo.
 */
export interface AccessProvider {
  readonly id: string;
  /** Router: problems with a policy for `repo`, empty if fine. */
  validate(policy: PolicyData, repo: string): Promise<string[]>;
  /** Router: credentials covering `policies`, for a container in `repo`. */
  mint(policies: PolicyData[], repo: string): Promise<AccessCredential[]>;
  /** Container: makes credentials usable by agents (files under `dir`, env). Called again on refresh. */
  install(credentials: AccessCredential[], dir: string): Promise<{ env: Record<string, string> }>;
}

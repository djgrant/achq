import type { Vault } from "../resources/resource.ts";

/** A secrets manager, e.g. 1Password, as `achq.config.ts` names it: `vault: { provider: "1password", name: "<vault>" }`. */
export interface VaultProvider {
  /** Its vault named `name`. */
  vault(name: string): Vault;
}

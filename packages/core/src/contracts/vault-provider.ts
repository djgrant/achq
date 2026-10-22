/**
 * Where `achq infra up` keeps a secret it makes once and reuses on another
 * router or machine, e.g. a GitHub App's private key: items by name, each a
 * set of named fields.
 */
export interface Vault {
  /** The item's fields, or undefined if there's no item of that name. */
  read(item: string): Promise<Record<string, string> | undefined>;
  /** Keeps `fields` as the item, in place of any item of that name. */
  write(item: string, fields: Record<string, string>): Promise<void>;
}

/** A secrets manager, e.g. 1Password, as `achq.config.ts` names it: `vault: { provider: "1password", name: "<vault>" }`. */
export interface VaultProvider {
  /** Its vault named `name`. */
  vault(name: string): Vault;
}

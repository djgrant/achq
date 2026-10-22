/** The vault provider id, as `achq.config.ts` names it: `vault: { provider: "1password", name }`. */
export const VAULT_PROVIDER = "1password";

export const ONEPASSWORD_ENV = {
  /** The command that runs 1Password's CLI, if not `op`: tests point it at a fake. */
  op: "ACHQ_1PASSWORD_OP",
} as const;

export const OP = ["op"];

/** What `op item get` says on stderr when the vault has no item of that name. */
export const NOT_AN_ITEM = /isn't an item/i;

/** The category achq's items are made in: a note, whose fields are all its own. */
export const ITEM_CATEGORY = "SECURE_NOTE";

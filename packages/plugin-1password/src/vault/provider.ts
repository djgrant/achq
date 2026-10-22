import type { Vault, VaultProvider } from "@achq/core";
import { Op } from "../lib/op.ts";

/** A 1Password vault, through `op`: each of achq's items is a note of concealed fields, by its title. */
export class OnePasswordVault implements Vault {
  constructor(
    private readonly op: Op,
    readonly name: string,
  ) {}

  async read(item: string) {
    const found = await this.op.get(this.name, item);
    if (!found) return undefined;
    const fields = (found.fields ?? []).filter((f) => f.label && typeof f.value === "string" && f.value !== "");
    return Object.fromEntries(fields.map((f) => [f.label!, f.value!]));
  }

  /** An item already there is archived, not deleted, so a key it held can still be found. */
  async write(item: string, fields: Record<string, string>) {
    const existing = await this.op.get(this.name, item);
    if (existing) await this.op.archive(this.name, existing.id);
    await this.op.create(this.name, item, fields);
  }
}

export class OnePasswordVaultProvider implements VaultProvider {
  constructor(private readonly op: Op) {}

  vault(name: string) {
    return new OnePasswordVault(this.op, name);
  }
}

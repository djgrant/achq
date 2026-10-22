import type { Implementation, VaultProvider } from "@achq/core";
import { Env } from "@achq/utils/env";
import { ONEPASSWORD_ENV, OP, VAULT_PROVIDER } from "../lib/constants.ts";
import { Op } from "../lib/op.ts";
import { OnePasswordVaultProvider } from "./provider.ts";

/** 1Password, through its CLI, `op`, as you're signed in to it. */
export const onePasswordVaultProvider: Implementation<VaultProvider> = {
  id: VAULT_PROVIDER,
  create: (vars) => new OnePasswordVaultProvider(new Op(new Env(vars).optional(ONEPASSWORD_ENV.op)?.split(" ") ?? OP)),
  privateEnv: [],
};

import type { Vault } from "@achq/core";
import { onePasswordVaultProvider } from "./vault/index.ts";

/**
 * The 1Password vault `name`, through `op` as you're signed in to it, for
 * `achq.config.ts`: `vault: onepassword.vault("achq")`. `op` is found when
 * the vault is first used, once achq has taken on the config's environment.
 */
export const vault = (name: string): Vault => {
  const open = () => onePasswordVaultProvider.create(process.env).vault(name);
  return { read: (item) => open().read(item), write: (item, fields) => open().write(item, fields) };
};

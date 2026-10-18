// Works with any SecretStore; Railway's is shared-variables.ts.
import type { SecretLocation, SecretRef, SecretStore } from "@achq/core";
import { secretDigest } from "@achq/core/secrets";
import type { Provider } from "@achq/reconcile";

/** Where a secret's value comes from: `generated` once, or `given` and kept in step with the giver. */
export type SecretSource = { source: () => string | Promise<string>; digest?: string };

export type SecretParams = SecretSource & { store: SecretStore; name: string; location: "store" };
export type Secret = SecretRef & { location: SecretLocation };

/** A secret made once, e.g. a random key, and kept from then on. */
export const generated = (make: () => string): SecretSource => ({ source: make });

/** A secret whose value comes from outside, e.g. the CLI's environment. A new value replaces the kept one. */
export const given = (value: string): SecretSource => ({ source: () => value, digest: secretDigest(value) });

const refOf = (store: SecretStore, name: string, value: string, location: SecretLocation): Secret => ({ name, ref: store.ref(name), digest: secretDigest(value), location });

export const secret: Provider<SecretParams, Secret> = {
  schema: { name: { kind: "key" }, digest: { kind: "param" }, location: { kind: "param" } },
  read: async ({ store, name }) => {
    const found = await store.read(name);
    return found && refOf(store, name, found.value, found.location);
  },
  create: async ({ store, name, source }) => {
    const value = await source();
    await store.write(name, value);
    return refOf(store, name, value, "store");
  },
  update: async ({ store, name, source, digest }, current) => {
    // A new digest means the source has a new value. Otherwise the value is only moving into the store.
    const value = digest !== undefined && digest !== current.digest ? await source() : (await store.read(name))!.value;
    await store.write(name, value);
    return refOf(store, name, value, "store");
  },
};

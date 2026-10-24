import type { JsonStore } from "./contracts/container-provider.ts";

/**
 * Moves each value in `store` to the name `rename` gives it, where that's a
 * new one: written there, then removed from the old. Run before anything else
 * uses the store, so a move a crash cut short is simply made again.
 *
 * For the one-time move off names stores were once given as file names
 * (`owner__name`); delete it once deployed infras have run it.
 */
export const renameStored = async <T>(store: JsonStore<T>, rename: (name: string, value: T) => string) => {
  for (const name of await store.list()) {
    const value = await store.read(name);
    if (value === undefined) continue;
    const renamed = rename(name, value);
    if (renamed === name) continue;
    await store.write(renamed, value);
    await store.remove(name);
  }
};

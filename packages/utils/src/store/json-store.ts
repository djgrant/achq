/**
 * JSON values by name, any string: one collection of what a service keeps,
 * as it was written, unread. A write is durable once it resolves: a crash
 * right after it loses nothing. `collection` reads one against its schema.
 */
export interface JsonStore<T = unknown> {
  read(name: string): Promise<T | undefined>;
  write(name: string, value: T): Promise<void>;
  /** Removing a missing name is fine. */
  remove(name: string): Promise<void>;
  /** Every stored name, sorted. */
  list(): Promise<string[]>;
  /** Every stored value, in name order. */
  all(): Promise<T[]>;
}

/** A service's durable storage: each of its collections, by name, as it was written. Only a service's `store.ts` opens them, through `collection`. */
export type Stores = (collection: string) => JsonStore;

/** Every value at `store`'s names, in name order: a name removed while listing is skipped. */
export const allOf = async <T>(store: Pick<JsonStore<T>, "list" | "read">) => {
  const values = await Promise.all((await store.list()).map((name) => store.read(name)));
  return values.filter((v) => v !== undefined);
};

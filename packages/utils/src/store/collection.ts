import type { z } from "zod";
import { allOf, type JsonStore, type Stores } from "./json-store.ts";

/**
 * A change to what a collection keeps, made once when it's opened, before
 * anything reads it: `raw` is the collection as it was written, and `parse`
 * gives a value as the schema reads it, or undefined. A migration is run on
 * every open, so it must leave alone what it has already changed.
 */
export type Migration<T> = (raw: JsonStore, parse: (value: unknown) => T | undefined) => Promise<void>;

export type CollectionOptions<T> = {
  /** In order, before `collection` returns. */
  migrate?: Migration<T>[];
  /** Where a value that fails its schema is reported. */
  log?: (line: string) => void;
};

/** The first thing wrong with a value, e.g. `containers.0.name: expected string`. */
const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
};

/**
 * The collection `name` in `stores`, read against `schema`, once each of
 * `migrate` has run. A value that fails its schema is treated as absent:
 * `read` gives undefined and `all` skips it, each logging the collection, the
 * name and what's wrong. Nothing removes it, so a newer version can still read
 * it, and the next write of its name replaces it.
 */
export const collection = async <T>(stores: Stores, name: string, schema: z.ZodType<T>, { migrate = [], log = console.log }: CollectionOptions<T> = {}) => {
  const raw = stores(name);
  const parse = (value: unknown) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  for (const migration of migrate) await migration(raw, parse);

  const read = async (key: string) => {
    const value = await raw.read(key);
    if (value === undefined) return undefined;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    log(`store: ${name} ${JSON.stringify(key)} isn't readable, so it's treated as absent: ${firstIssue(parsed.error)}`);
    return undefined;
  };

  const opened: JsonStore<T> = {
    read,
    write: (key, value) => raw.write(key, value),
    remove: (key) => raw.remove(key),
    list: () => raw.list(),
    all: () => allOf({ list: () => raw.list(), read }),
  };
  return opened;
};

/**
 * Moves each value to the name `rename` gives it, where that's a new one:
 * written there as it was, then removed from the old. A value its schema
 * can't read stays where it is. A move a crash cut short is made again on the
 * next open.
 */
export const renamed =
  <T>(rename: (name: string, value: T) => string): Migration<T> =>
  async (raw, parse) => {
    for (const name of await raw.list()) {
      const value = await raw.read(name);
      const parsed = parse(value);
      if (parsed === undefined) continue;
      const to = rename(name, parsed);
      if (to === name) continue;
      await raw.write(to, value);
      await raw.remove(name);
    }
  };

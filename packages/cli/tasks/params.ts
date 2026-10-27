import type { Context } from "@achq/core";
import type { Vars } from "@achq/utils/env";
import * as v from "valibot";

// pok reads a param's choices (a picklist), whether it's an array, and an object's keys through Standard JSON
// Schema, which Valibot's schemas don't implement: pok finds none, and so lists no choices and prompts for text.
// A param of one of those types needs wrapping in @valibot/to-json-schema's toStandardJsonSchema, or a validator
// that implements it, e.g. zod or ArkType.

/** A param pok hands the task as it is: a function, an infra, a client. */
export const given = <T>() => v.custom<T>((value) => value !== undefined);

/** A given param, or `fallback()`'s when it isn't given. */
export const givenOr = <T>(fallback: () => T) => v.optional<v.CustomSchema<T, undefined>, () => T>(given<T>(), fallback);

/** A given param that may be left out. */
export const maybe = <T>() => v.optional(given<T>());

/** Writes a line of what a task reports: by default, to stdout. */
export const log = givenOr<(line: string) => void>(() => (line: string) => console.log(line));

/** Sleeps between polls: for real unless given another, as tests do. */
export const sleep = givenOr<(ms: number) => Promise<void>>(() => (ms: number) => Bun.sleep(ms));

/** Opens `url` in your browser to `what`. */
export type Open = (url: string, what: string) => Promise<void>;

/** What a task that plans or applies resources gets as the Context's parts, for `context`: your shell's environment unless given one. */
export const contextParams = {
  env: givenOr<Vars>(() => process.env),
  log,
  sleep,
  newSecret: maybe<() => string>(),
  vault: maybe<NonNullable<Context["vault"]>>(),
};

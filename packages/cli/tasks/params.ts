import type { Context } from "@achq/core";
import type { Vars } from "@achq/utils/env";
import { z } from "zod";

/** A param pok hands the task as it is: a function, an infra, a client. */
export const given = <T>() => z.custom<T>((value) => value !== undefined);

/** Writes a line of what a task reports: by default, to stdout. */
export const log = given<(line: string) => void>().default(() => (line: string) => console.log(line));

/** Sleeps between polls: for real unless given another, as tests do. */
export const sleep = given<(ms: number) => Promise<void>>().default(() => (ms: number) => Bun.sleep(ms));

/** Opens `url` in your browser to `what`. */
export type Open = (url: string, what: string) => Promise<void>;

/** What a task that plans or applies resources gets as the Context's parts, for `context`: your shell's environment unless given one. */
export const contextParams = {
  env: given<Vars>().default(() => process.env),
  log,
  sleep,
  newSecret: given<() => string>().optional(),
  vault: given<NonNullable<Context["vault"]>>().optional(),
};

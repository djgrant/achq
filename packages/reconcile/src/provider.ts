import type { Changed } from "./diff.ts";
import type { Schema } from "./schema.ts";

/**
 * One kind of live object. Nothing is stored between runs: `read` says what
 * exists, and the plan is the difference between it and the params.
 */
export interface Provider<P, O> {
  readonly schema: Schema<P>;
  /** What exists for these params, or undefined if nothing does. Its fields are compared with the params of the same name. */
  read(params: P): Promise<O | undefined>;
  /** Left out when the resource exists whenever what it belongs to does, e.g. a service's variables. */
  create?(params: P): Promise<O>;
  /** Left out when nothing about the resource can change. */
  update?(params: P, current: O, changed: Changed[]): Promise<O>;
  /**
   * The output after `update`, for planning what depends on it. Without this,
   * it's the current output with the new params in place. Undefined means it
   * can't be known until it's applied.
   */
  predict?(params: P, current: O): O | undefined;
  /** Problems with what exists that the provider can't fix itself, to show after the plan. */
  notes?(params: P, output: O): string[];
}

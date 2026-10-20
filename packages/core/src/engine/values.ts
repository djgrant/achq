// What resources take and give: plain values, or outputs of other resources,
// which can be unknown until what they come from is created.
import { deepEqual, isPlainObject } from "@achq/utils/json";
import type { ManagedResource } from "../resources/resource.ts";

/** A value not known until what it comes from is created, e.g. a new service's URL. */
export const UNKNOWN: unique symbol = Symbol("known after apply");
export type Unknown = typeof UNKNOWN;

/** A value generated once, then kept: e.g. a key, in a service's variables. */
export const GENERATED: unique symbol = Symbol("generated once");

export const known = <T>(value: T | Unknown): value is T => value !== UNKNOWN;

export const isPlain = isPlainObject;

/** Whether `value` is, or holds, an unknown. */
export const hasUnknown = (value: unknown): boolean =>
  value === UNKNOWN || (Array.isArray(value) ? value.some(hasUnknown) : isPlain(value) && Object.values(value).some(hasUnknown));

/** Each resource's outputs, as planned or as applied. */
export type Outputs = Map<ManagedResource, unknown>;

/** A value resources produce, for another resource to take as an input. */
export class Output<T> {
  constructor(
    /** The resources it comes from: whatever takes it is planned after them. */
    readonly from: ManagedResource[],
    readonly get: (outputs: Outputs) => T | Unknown,
  ) {}

  /** Unknown while any of the value is. */
  map<U>(f: (value: T) => U): Output<U> {
    return new Output(this.from, (outputs) => {
      const value = this.get(outputs);
      return hasUnknown(value) ? UNKNOWN : f(value as T);
    });
  }
}

export type Input<T> = T | Output<T>;
/** A resource's props, any part of which can come from another resource. */
export type Inputs<T> = Input<T> | (T extends object ? { [K in keyof T]: Inputs<T[K]> } : never);

/** Outputs as planned: any of them can be unknown until the resource is applied. */
export type Planned<A> = { [K in keyof A]: A[K] | Unknown };

/** Joins several inputs into one, unknown while any of them is. */
export const all = <T extends unknown[]>(inputs: { [K in keyof T]: Input<T[K]> }): Output<T> =>
  new Output(
    inputs.flatMap((i) => (i instanceof Output ? i.from : [])),
    (outputs) => {
      const values = inputs.map((i) => resolve(i, outputs));
      return hasUnknown(values) ? UNKNOWN : (values as T);
    },
  );

/** `value` with every output in it replaced by its value in `outputs`. */
export const resolve = (value: unknown, outputs: Outputs): any => {
  if (value instanceof Output) return value.get(outputs);
  if (Array.isArray(value)) return value.map((v) => resolve(v, outputs));
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, outputs)]));
  return value;
};

/** The resources `value`'s outputs come from. */
export const dependencies = (value: unknown): ManagedResource[] => {
  if (value instanceof Output) return value.from;
  if (Array.isArray(value)) return value.flatMap(dependencies);
  if (isPlain(value)) return Object.values(value).flatMap(dependencies);
  return [];
};

/** Deep equality over what `resolve` makes: plain objects, arrays and other values by identity. */
export const same = deepEqual;

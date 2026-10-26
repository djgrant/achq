/*
 * Marks on core's classes, found whichever copy of `@achq/core` made the
 * value. `instanceof` only knows its own copy's class, and one process can
 * load two: a CLI installed globally and the infra repo's, which the infra's
 * plugins import; or a service's and the one its plugins were installed with.
 */

/** The mark for core's class `name`: one symbol across copies. */
export const brand = (name: string) => Symbol.for(`achq.${name}`);

/** A check that `value` carries `mark`, as an instance of its class from any copy of core does. */
export const branded =
  <T>(mark: symbol) =>
  (value: unknown): value is T =>
    typeof value === "object" && value !== null && mark in value;

/** A value kept once per process rather than once per copy of core, e.g. the resources a config has declared. */
export const perProcess = <T>(name: string, init: () => T): T => {
  const global = globalThis as Record<symbol, unknown>;
  const key = brand(name);
  if (!(key in global)) global[key] = init();
  return global[key] as T;
};

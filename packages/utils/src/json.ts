/**
 * A JSON value. Its arrays and objects are interfaces, not inline types, so a
 * type that maps over it, as Hono's `JSONParsed` does for a route's response,
 * sees the same type at each level and ends rather than going on forever.
 */
export type Json = string | number | boolean | null | JsonArray | JsonObject;
export interface JsonArray extends Array<Json> {}
export interface JsonObject {
  [key: string]: Json;
}

export const json = {
  /** An object literal or `Object.create(null)`: not an array, a class instance or a function. */
  isPlainObject: (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  },

  /** The same text for the same data, whatever order its keys were set in. */
  stableStringify: (value: Json): string => {
    if (Array.isArray(value)) return `[${value.map(json.stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${json.stableStringify(value[k]!)}`).join(",")}}`;
    }
    return JSON.stringify(value);
  },

  /** Deep equality over plain objects and arrays. Anything else is compared by identity. */
  deepEqual: (a: unknown, b: unknown): boolean => {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => json.deepEqual(v, b[i]));
    if (json.isPlainObject(a) && json.isPlainObject(b)) {
      const keys = Object.keys(a);
      return keys.length === Object.keys(b).length && keys.every((k) => k in b && json.deepEqual(a[k], b[k]));
    }
    return a === b;
  },

  /**
   * `value` as JSON, or an error naming the path (from `at`) that isn't plain
   * data. `undefined` object fields are dropped, as JSON.stringify drops them.
   */
  from: (value: unknown, at = "value"): Json => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${at} is not a finite number`);
      return value;
    }
    if (Array.isArray(value)) return value.map((item, i) => json.from(item, `${at}[${i}]`));
    if (!json.isPlainObject(value)) throw new Error(`${at} is not plain data (${typeof value})`);
    const out: { [key: string]: Json } = {};
    for (const [key, field] of Object.entries(value)) {
      if (field !== undefined) out[key] = json.from(field, `${at}.${key}`);
    }
    return out;
  },
};

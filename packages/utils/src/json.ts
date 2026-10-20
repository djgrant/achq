// Pure, with no Node or Bun imports, because core uses it inside the config
// sandbox.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** An object literal or `Object.create(null)`: not an array, a class instance or a function. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const stableStringify = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sameJson = (a: Json, b: Json): boolean => stableStringify(a) === stableStringify(b);

/** Deep equality over plain objects and arrays. Anything else is compared by identity. */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return a === b;
};

/**
 * `value` as JSON, or an error naming the path (from `at`) that isn't plain
 * data. `undefined` object fields are dropped, as JSON.stringify drops them.
 */
export const toJsonValue = (value: unknown, at = "value"): Json => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value, at);
  if (Array.isArray(value)) return value.map((item, i) => toJsonValue(item, `${at}[${i}]`));
  if (typeof value === "object") return jsonObject(value, at);
  throw new Error(`${at} is not plain data (${typeof value})`);
};

const finiteNumber = (value: number, at: string) => {
  if (!Number.isFinite(value)) throw new Error(`${at} is not a finite number`);
  return value;
};

const jsonObject = (value: object, at: string) => {
  if (!isPlainObject(value)) throw new Error(`${at} is not plain data`);
  const out: { [key: string]: Json } = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    out[key] = toJsonValue(field, `${at}.${key}`);
  }
  return out;
};

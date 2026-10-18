// Plain data: what crosses from repo config into the deployer and router.
// No Node or Bun imports: this runs inside the config sandbox too.

export type Data = string | number | boolean | null | Data[] | { [key: string]: Data };

/** JSON with object keys sorted, so equal data always serialises the same way. */
export const stableStringify = (value: Data): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sameData = (a: Data, b: Data) => stableStringify(a) === stableStringify(b);

/**
 * Converts a value to Data, or throws naming the path that isn't plain data.
 * `undefined` object fields are dropped, as JSON would.
 */
export const toData = (value: unknown, at = "value"): Data => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${at} is not a finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => toData(v, `${at}[${i}]`));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error(`${at} is not plain data`);
    const out: { [key: string]: Data } = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toData(v, `${at}.${k}`);
    return out;
  }
  throw new Error(`${at} is not plain data (${typeof value})`);
};

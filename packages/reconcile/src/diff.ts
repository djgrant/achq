import type { Schema } from "./schema.ts";

/** A param that differs. For a plain object, the entries that differ. */
export type Changed = { field: string; entries?: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => equal(a[k], b[k]));
  }
  return false;
};

/** The params in `desired` that differ from `current`, and which of those are immutable. */
export const diff = <P>(schema: Schema<P>, desired: P, current: unknown) => {
  const want = desired as Record<string, unknown>;
  const have = (isRecord(current) ? current : {}) as Record<string, unknown>;
  const changed: Changed[] = [];
  const immutable: string[] = [];
  for (const [field, spec] of Object.entries(schema) as [string, Schema<P>[keyof P]][]) {
    if (spec?.kind !== "param" || want[field] === undefined) continue;
    const value = want[field];
    if (isRecord(value)) {
      const before = isRecord(have[field]) ? (have[field] as Record<string, unknown>) : {};
      const entries = Object.keys(value).filter((k) => value[k] !== undefined && !equal(value[k], before[k]));
      if (!entries.length) continue;
      changed.push({ field, entries });
    } else if (!equal(value, have[field])) {
      changed.push({ field });
    } else continue;
    if (spec.immutable) immutable.push(field);
  }
  return { changed, immutable };
};

/** The current output with the desired params in place, entry by entry for plain objects. */
export const overlay = <P, O>(schema: Schema<P>, desired: P, current: O): O => {
  const want = desired as Record<string, unknown>;
  const out = { ...(current as Record<string, unknown>) };
  for (const [field, spec] of Object.entries(schema) as [string, Schema<P>[keyof P]][]) {
    if (spec?.kind !== "param" || want[field] === undefined) continue;
    const value = want[field];
    out[field] = isRecord(value) && isRecord(out[field]) ? { ...(out[field] as Record<string, unknown>), ...value } : value;
  }
  return out as O;
};

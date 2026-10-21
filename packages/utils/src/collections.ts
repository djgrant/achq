export const collections = {
  /** The values that occur more than once, each once, in the order they first repeat. */
  duplicates: <T>(values: Iterable<T>): T[] => {
    const seen = new Set<T>();
    const repeated = new Set<T>();
    for (const value of values) (seen.has(value) ? repeated : seen).add(value);
    return [...repeated];
  },

  /** The item when there's exactly one. */
  only: <T>(list: readonly T[]): T | undefined => (list.length === 1 ? list[0] : undefined),

  mapValues: <V, W>(record: Record<string, V>, fn: (value: V, key: string) => W): Record<string, W> =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fn(v, k)])),

  filterKeys: <V>(record: Record<string, V>, keep: (key: string) => boolean): Record<string, V> => Object.fromEntries(Object.entries(record).filter(([k]) => keep(k))),

  sortKeys: <V>(record: Record<string, V>): Record<string, V> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))),
};

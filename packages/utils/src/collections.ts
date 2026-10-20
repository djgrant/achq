// Pure, with no Node or Bun imports, so core's planner can use it inside the
// config sandbox.

/**
 * `roots` and everything reachable from them through `next`, each once, in
 * depth-first order: a node, then what it leads to. `next` is asked once per node.
 */
export const reachable = <T>(roots: Iterable<T>, next: (node: T) => Iterable<T>): T[] => {
  const seen = new Set<T>();
  const visit = (node: T) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const n of next(node)) visit(n);
  };
  for (const root of roots) visit(root);
  return [...seen];
};

/**
 * `nodes` and what they depend on, each after its dependencies, otherwise in
 * the order given. A cycle throws, naming it with `label`: `A cycle: a → b → a`.
 */
export const topoSort = <T>(nodes: Iterable<T>, dependenciesOf: (node: T) => Iterable<T>, label: (node: T) => string): T[] => {
  const order = new Set<T>();
  const visiting: T[] = [];
  const visit = (node: T) => {
    if (order.has(node)) return;
    if (visiting.includes(node)) throw new Error(`A cycle: ${[...visiting.slice(visiting.indexOf(node)), node].map(label).join(" → ")}`);
    visiting.push(node);
    for (const d of dependenciesOf(node)) visit(d);
    visiting.pop();
    order.add(node);
  };
  for (const node of nodes) visit(node);
  return [...order];
};

/** The values that occur more than once, each once, in the order they first repeat. */
export const duplicates = <T>(values: Iterable<T>): T[] => {
  const seen = new Set<T>();
  const repeated = new Set<T>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
};

export const onlyItem = <T>(list: readonly T[]): T | undefined => (list.length === 1 ? list[0] : undefined);

export const mapValues = <V, W>(record: Record<string, V>, fn: (value: V, key: string) => W): Record<string, W> =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fn(v, k)]));

export const filterKeys = <V>(record: Record<string, V>, keep: (key: string) => boolean): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => keep(k)));

export const sortKeys = <V>(record: Record<string, V>): Record<string, V> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

export const graph = {
  /**
   * `roots` and everything reachable from them through `next`, each once, in
   * depth-first order: a node, then what it leads to. `next` is asked once per node.
   */
  reachable: <T>(roots: Iterable<T>, next: (node: T) => Iterable<T>): T[] => {
    const seen = new Set<T>();
    const visit = (node: T) => {
      if (seen.has(node)) return;
      seen.add(node);
      for (const n of next(node)) visit(n);
    };
    for (const root of roots) visit(root);
    return [...seen];
  },

  /**
   * `nodes` and what they depend on, each after its dependencies, otherwise in
   * the order given. A cycle throws, naming it with `label`: `A cycle: a → b → a`.
   */
  topoSort: <T>(nodes: Iterable<T>, dependenciesOf: (node: T) => Iterable<T>, label: (node: T) => string): T[] => {
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
  },
};

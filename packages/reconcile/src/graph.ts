// Nodes are evaluated on demand: reading another node's output from params
// evaluates it first. So the order nodes are added in doesn't matter, and a
// node can read a contribution that resources added after it fill in.
import { type Change, describeChanged } from "./change.ts";
import { diff, overlay } from "./diff.ts";
import type { Provider } from "./provider.ts";

/** Reads another node's output, from a node's params. */
export type Out = <O>(node: Node<O>) => Promise<O>;

/** A node's params, or how to make them from other nodes' outputs. */
export type Params<P> = P | ((out: Out) => P | Promise<P>);

type Spec =
  | { kind: "resource"; provider: Provider<any, any>; params: Params<unknown> }
  | { kind: "derived"; compute: (out: Out) => unknown };

/** A resource, or a value derived from other nodes. Its label names it in plans. */
export class Node<O = unknown> {
  declare readonly _output?: O;
  constructor(
    readonly label: string,
    readonly spec: Spec,
  ) {}
}

/** A list one node owns and others add to while the graph is built. Closed once planning starts. */
export class Contribution<T> {
  #items: T[] = [];
  #closed = false;

  add(item: T) {
    if (this.#closed) throw new Error("Nothing can be added to a contribution once planning has started");
    this.#items.push(item);
  }

  all(): readonly T[] {
    return this.#items;
  }

  close() {
    this.#closed = true;
  }
}

/** What planning or applying found and did. */
export type Run = {
  changes: Change[];
  notes: string[];
  /** A node's output, as it is or (in a plan) as it will be. Undefined while it depends on a change not yet applied. */
  output<O>(node: Node<O>): O | undefined;
  /** Whether the node is created or updated. */
  changed(node: Node): boolean;
};

/** Thrown through params that read the output of a node that isn't known until applied. */
class Pending extends Error {
  constructor(readonly after: string) {
    super(`Known after ${after}`);
  }
}

type Outcome = { known: true; output: unknown; changed: boolean } | { known: false; after: string; changed: boolean };

export class Graph {
  readonly #nodes: Node[] = [];
  readonly #contributions: Contribution<unknown>[] = [];

  add<P, O>(label: string, provider: Provider<P, O>, params: Params<P>): Node<O> {
    return this.#push(new Node<O>(label, { kind: "resource", provider, params: params as Params<unknown> }));
  }

  /** A value computed from other nodes. It has nothing to read or change. */
  derive<O>(label: string, compute: (out: Out) => O | Promise<O>): Node<O> {
    return this.#push(new Node<O>(label, { kind: "derived", compute }));
  }

  contribution<T>(): Contribution<T> {
    const c = new Contribution<T>();
    this.#contributions.push(c as Contribution<unknown>);
    return c;
  }

  /** What would change. Reads everything and changes nothing. */
  plan(): Promise<Run> {
    return this.#run(false);
  }

  /** Makes the changes. Each node is read again just before it's applied, and `onChange` hears each change before it's made. */
  apply(onChange?: (change: Change) => void): Promise<Run> {
    return this.#run(true, onChange);
  }

  #push<O>(node: Node<O>) {
    if (this.#nodes.some((n) => n.label === node.label)) throw new Error(`Two nodes are labelled "${node.label}"`);
    this.#nodes.push(node);
    return node;
  }

  async #run(apply: boolean, onChange?: (change: Change) => void): Promise<Run> {
    for (const c of this.#contributions) c.close();
    const outcomes = new Map<Node, Promise<Outcome>>();
    const settled = new Map<Node, Outcome>();
    const changes: Change[] = [];
    const notes: string[] = [];
    const emit = (change: Change) => {
      changes.push(change);
      onChange?.(change);
    };
    const note = (provider: Provider<unknown, unknown>, params: unknown, output: unknown) => notes.push(...(provider.notes?.(params, output) ?? []));

    const evaluate = async (node: Node, path: Node[]): Promise<Outcome> => {
      if (path.includes(node)) throw new Error(`Cycle: ${[...path.slice(path.indexOf(node)), node].map((n) => n.label).join(" → ")}`);
      let outcome = outcomes.get(node);
      if (!outcome) {
        outcome = settle(node, [...path, node]).then((o) => (settled.set(node, o), o));
        outcomes.set(node, outcome);
      }
      return outcome;
    };

    const settle = async (node: Node, path: Node[]): Promise<Outcome> => {
      const out: Out = async (dep) => {
        const o = await evaluate(dep, path);
        if (!o.known) throw new Pending(o.after);
        return o.output as never;
      };
      const { spec } = node;
      if (spec.kind === "derived") {
        try {
          return { known: true, output: await spec.compute(out), changed: false };
        } catch (e) {
          if (e instanceof Pending) return { known: false, after: e.after, changed: false };
          throw e;
        }
      }

      const provider = spec.provider as Provider<unknown, unknown>;
      let params: unknown;
      try {
        params = typeof spec.params === "function" ? await (spec.params as (out: Out) => unknown)(out) : spec.params;
      } catch (e) {
        if (!(e instanceof Pending)) throw e;
        emit({ op: "?", target: node.label, detail: `(after ${e.after})` });
        return { known: false, after: e.after, changed: true };
      }

      const current = await provider.read(params);
      if (current === undefined) {
        if (!provider.create) throw new Error(`${node.label} doesn't exist, and can't be created`);
        emit({ op: "+", target: node.label });
        if (!apply) return { known: false, after: node.label, changed: true };
        const output = await provider.create(params);
        note(provider, params, output);
        return { known: true, output, changed: true };
      }

      const { changed, immutable } = diff(provider.schema, params, current);
      if (immutable.length) throw new Error(`${node.label}: ${immutable.join(", ")} can't be changed once it exists`);
      if (!changed.length) {
        note(provider, params, current);
        return { known: true, output: current, changed: false };
      }
      if (!provider.update) throw new Error(`${node.label}: ${describeChanged(changed)} differs, and it can't be updated`);
      emit({ op: "~", target: node.label, detail: describeChanged(changed) });
      if (!apply) {
        note(provider, params, current);
        const predicted = provider.predict ? provider.predict(params, current) : overlay(provider.schema, params, current);
        return predicted === undefined ? { known: false, after: node.label, changed: true } : { known: true, output: predicted, changed: true };
      }
      const output = await provider.update(params, current, changed);
      note(provider, params, output);
      return { known: true, output, changed: true };
    };

    // One at a time, so changes happen and print in a stable order.
    for (const node of this.#nodes) await evaluate(node, []);

    return {
      changes,
      notes,
      output: <O>(node: Node<O>) => {
        const o = settled.get(node);
        return o?.known ? (o.output as O) : undefined;
      },
      changed: (node) => settled.get(node)?.changed ?? false,
    };
  }
}

export const graph = () => new Graph();

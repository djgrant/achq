import { expect, test } from "bun:test";
import { formatChange, graph, type Node, type Provider } from "../src/index.ts";

/** An in-memory kind of thing, keyed by name, that records what's done to it. */
const things = () => {
  const live = new Map<string, { name: string; size: number; tags: Record<string, string>; id: string }>();
  const done: string[] = [];
  let next = 1;
  const provider: Provider<{ name: string; size?: number; tags?: Record<string, string>; parent?: string }, { name: string; size: number; tags: Record<string, string>; id: string }> = {
    schema: { name: { kind: "key" }, size: { kind: "param" }, tags: { kind: "param" } },
    read: async ({ name }) => (live.has(name) ? structuredClone(live.get(name)) : undefined),
    create: async ({ name, size = 0, tags = {} }) => {
      done.push(`create ${name}`);
      const thing = { name, size, tags, id: `id-${next++}` };
      live.set(name, thing);
      return structuredClone(thing);
    },
    update: async ({ name, size, tags }, current, changed) => {
      done.push(`update ${name} ${changed.map((c) => c.field).join(",")}`);
      const thing = { ...current, ...(size !== undefined && { size }), tags: { ...current.tags, ...tags } };
      live.set(name, thing);
      return structuredClone(thing);
    },
  };
  return { live, done, provider };
};

test("a plan creates nothing, and shows what depends on a new node as known after it", async () => {
  const t = things();
  const g = graph();
  const parent = g.add("parent", t.provider, { name: "parent" });
  const child = g.add("child", t.provider, async (o) => ({ name: `child-of-${(await o(parent)).id}` }));
  g.add("grandchild", t.provider, async (o) => ({ name: `grandchild-of-${(await o(child)).id}` }));

  const plan = await g.plan();
  expect(plan.changes.map(formatChange)).toEqual(["+ parent", "? child (after parent)", "? grandchild (after parent)"]);
  expect(t.done).toEqual([]);
  expect(plan.output(parent)).toBeUndefined();

  const applied = await g.apply();
  expect(t.done).toEqual(["create parent", "create child-of-id-1", "create grandchild-of-id-2"]);
  expect(applied.output(child)?.name).toBe("child-of-id-1");
  expect(applied.changed(child)).toBe(true);

  const again = await g.apply();
  expect(again.changes).toEqual([]);
  expect(again.changed(child)).toBe(false);
});

test("nodes are evaluated on demand, so a node can read a contribution filled in by nodes added after it", async () => {
  const t = things();
  const g = graph();
  const sizes = g.contribution<ReturnType<typeof g.add<{ name: string }, { size: number }>>>();
  const total = g.add("total", t.provider, async (o) => ({ name: "total", size: (await Promise.all(sizes.all().map(o))).reduce((n, s) => n + s.size, 0) }));
  sizes.add(g.add("a", t.provider, { name: "a", size: 2 }));
  sizes.add(g.add("b", t.provider, { name: "b", size: 3 }));

  await g.apply();
  expect(t.done).toEqual(["create a", "create b", "create total"]);
  expect(t.live.get("total")?.size).toBe(5);
  expect(() => sizes.add(g.add("c", t.provider, { name: "c" }))).toThrow("planning has started");
});

test("an update shows the params that differ, and a plain object only the entries it lists", async () => {
  const t = things();
  t.live.set("x", { name: "x", size: 1, tags: { keep: "1", mine: "old", other: "theirs" }, id: "id-x" });
  const g = graph();
  const x = g.add("x", t.provider, { name: "x", size: 2, tags: { mine: "new", keep: "1" } });
  const after = g.derive("x size", async (o) => (await o(x)).size);

  const plan = await g.plan();
  expect(plan.changes.map(formatChange)).toEqual(["~ x size, mine"]);
  expect(plan.output(after)).toBe(2); // predicted: the current output with the new params
  expect(plan.output(x)?.tags).toEqual({ keep: "1", mine: "new", other: "theirs" });

  await g.apply();
  expect(t.done).toEqual(["update x size,tags"]);
  expect(t.live.get("x")?.tags).toEqual({ keep: "1", mine: "new", other: "theirs" });
});

test("a param left undefined isn't managed", async () => {
  const t = things();
  t.live.set("x", { name: "x", size: 9, tags: {}, id: "id-x" });
  const g = graph();
  g.add("x", t.provider, { name: "x" });
  expect((await g.plan()).changes).toEqual([]);
});

test("apply reads each node again, so it acts on what exists then, not on the plan", async () => {
  const t = things();
  const g = graph();
  g.add("x", t.provider, { name: "x", size: 1 });
  expect((await g.plan()).changes.map(formatChange)).toEqual(["+ x"]);
  t.live.set("x", { name: "x", size: 1, tags: {}, id: "made-elsewhere" });
  const applied = await g.apply();
  expect(applied.changes).toEqual([]);
  expect(t.done).toEqual([]);
});

test("a prediction can say an output isn't known until the update is applied", async () => {
  const t = things();
  t.live.set("x", { name: "x", size: 1, tags: {}, id: "id-x" });
  const g = graph();
  const x = g.add("x", { ...t.provider, predict: () => undefined }, { name: "x", size: 2 });
  g.add("y", t.provider, async (o) => ({ name: `y-${(await o(x)).size}` }));
  expect((await g.plan()).changes.map(formatChange)).toEqual(["~ x size", "? y (after x)"]);
});

test("cycles, immutable params, duplicate labels and missing operations are errors", async () => {
  const t = things();
  const cyclic = graph();
  let b: Node<{ id: string }>;
  const a = cyclic.add("a", t.provider, async (o) => ({ name: `a-${(await o(b)).id}` }));
  b = cyclic.add("b", t.provider, async (o) => ({ name: `b-${(await o(a)).id}` }));
  await expect(cyclic.plan()).rejects.toThrow("Cycle: a → b → a");

  t.live.set("x", { name: "x", size: 1, tags: {}, id: "id-x" });
  const fixed = graph();
  fixed.add("x", { ...t.provider, schema: { size: { kind: "param", immutable: true } } }, { name: "x", size: 2 });
  await expect(fixed.plan()).rejects.toThrow("x: size can't be changed once it exists");

  const frozen = graph();
  frozen.add("x", { ...t.provider, update: undefined }, { name: "x", size: 2 });
  await expect(frozen.plan()).rejects.toThrow("x: size differs, and it can't be updated");

  const attached = graph();
  attached.add("y", { ...t.provider, create: undefined }, { name: "y" });
  await expect(attached.plan()).rejects.toThrow("y doesn't exist, and can't be created");

  const dupes = graph();
  dupes.add("x", t.provider, { name: "x" });
  expect(() => dupes.add("x", t.provider, { name: "x" })).toThrow('Two nodes are labelled "x"');
});

test("notes come from what exists, after planning and after applying", async () => {
  const t = things();
  t.live.set("x", { name: "x", size: 0, tags: {}, id: "id-x" });
  const g = graph();
  g.add("x", { ...t.provider, notes: (_p, out) => (out.size === 0 ? [`${out.name} is empty`] : []) }, { name: "x" });
  expect((await g.plan()).notes).toEqual(["x is empty"]);
  expect((await g.apply()).notes).toEqual(["x is empty"]);
});

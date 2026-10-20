import { expect, test } from "bun:test";
import { duplicates, filterKeys, mapValues, onlyItem, reachable, sortKeys, topoSort } from "../src/collections.ts";

const graph: Record<string, string[]> = { a: ["b", "c"], b: ["d"], c: ["d"], d: [] };
const edges = (n: string) => graph[n] ?? [];

test("reachable lists each node once, depth first, asking for its edges once", () => {
  const asked: string[] = [];
  expect(reachable(["a"], (n) => (asked.push(n), edges(n)))).toEqual(["a", "b", "d", "c"]);
  expect(asked).toEqual(["a", "b", "d", "c"]);
});

test("topoSort puts dependencies first, otherwise keeping the given order", () => {
  expect(topoSort(["a"], edges, String)).toEqual(["d", "b", "c", "a"]);
  expect(topoSort(["c", "b"], edges, String)).toEqual(["d", "c", "b"]);
});

test("topoSort names a cycle", () => {
  const cyclic: Record<string, string[]> = { a: ["b"], b: ["c"], c: ["b"] };
  expect(() => topoSort(["a"], (n) => cyclic[n]!, (n) => n.toUpperCase())).toThrow("A cycle: B → C → B");
});

test("duplicates gives each repeated value once", () => {
  expect(duplicates(["a", "b", "a", "c", "b", "a"])).toEqual(["a", "b"]);
  expect(duplicates([1, 2, 3])).toEqual([]);
});

test("onlyItem is the item of a one-item list", () => {
  expect(onlyItem(["x"])).toBe("x");
  expect(onlyItem([])).toBeUndefined();
  expect(onlyItem(["x", "y"])).toBeUndefined();
});

test("records: mapValues, filterKeys, sortKeys", () => {
  expect(mapValues({ a: 1, b: 2 }, (v, k) => `${k}${v}`)).toEqual({ a: "a1", b: "b2" });
  expect(filterKeys({ GIT_A: 1, HOME: 2 }, (k) => k.startsWith("GIT_"))).toEqual({ GIT_A: 1 });
  expect(Object.keys(sortKeys({ b: 1, a: 2 }))).toEqual(["a", "b"]);
});

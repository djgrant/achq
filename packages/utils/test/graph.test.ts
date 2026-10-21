import { expect, test } from "bun:test";
import { graph } from "../src/graph.ts";

const edges: Record<string, string[]> = { a: ["b", "c"], b: ["d"], c: ["d"], d: [] };
const next = (n: string) => edges[n] ?? [];

test("reachable lists each node once, depth first, asking for its edges once", () => {
  const asked: string[] = [];
  expect(graph.reachable(["a"], (n) => (asked.push(n), next(n)))).toEqual(["a", "b", "d", "c"]);
  expect(asked).toEqual(["a", "b", "d", "c"]);
});

test("topoSort puts dependencies first, otherwise keeping the given order", () => {
  expect(graph.topoSort(["a"], next, String)).toEqual(["d", "b", "c", "a"]);
  expect(graph.topoSort(["c", "b"], next, String)).toEqual(["d", "c", "b"]);
});

test("topoSort names a cycle", () => {
  const cyclic: Record<string, string[]> = { a: ["b"], b: ["c"], c: ["b"] };
  expect(() => graph.topoSort(["a"], (n) => cyclic[n]!, (n) => n.toUpperCase())).toThrow("A cycle: B → C → B");
});

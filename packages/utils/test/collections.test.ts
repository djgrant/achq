import { expect, test } from "bun:test";
import { collections } from "../src/collections.ts";

test("duplicates gives each repeated value once", () => {
  expect(collections.duplicates(["a", "b", "a", "c", "b", "a"])).toEqual(["a", "b"]);
  expect(collections.duplicates([1, 2, 3])).toEqual([]);
});

test("only is the item of a one-item list", () => {
  expect(collections.only(["x"])).toBe("x");
  expect(collections.only([])).toBeUndefined();
  expect(collections.only(["x", "y"])).toBeUndefined();
});

test("records: mapValues, filterKeys, sortKeys", () => {
  expect(collections.mapValues({ a: 1, b: 2 }, (v, k) => `${k}${v}`)).toEqual({ a: "a1", b: "b2" });
  expect(collections.filterKeys({ GIT_A: 1, HOME: 2 }, (k) => k.startsWith("GIT_"))).toEqual({ GIT_A: 1 });
  expect(Object.keys(collections.sortKeys({ b: 1, a: 2 }))).toEqual(["a", "b"]);
});

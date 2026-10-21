import { describe, expect, test } from "bun:test";
import { json } from "../src/json.ts";

test("stableStringify sorts keys at every depth", () => {
  expect(json.stableStringify({ b: 1, a: [{ d: 2, c: null }] })).toBe(`{"a":[{"c":null,"d":2}],"b":1}`);
  expect(json.stableStringify({ a: 1, b: 2 })).toBe(json.stableStringify({ b: 2, a: 1 }));
});

test("isPlainObject accepts literals and null-prototype objects only", () => {
  expect(json.isPlainObject({})).toBe(true);
  expect(json.isPlainObject(Object.create(null))).toBe(true);
  expect(json.isPlainObject([])).toBe(false);
  expect(json.isPlainObject(new Date())).toBe(false);
  expect(json.isPlainObject(null)).toBe(false);
});

test("deepEqual compares plain data structurally and anything else by identity", () => {
  expect(json.deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  expect(json.deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(json.deepEqual([1, 2], [1])).toBe(false);
  expect(json.deepEqual(new Date(0), new Date(0))).toBe(false);
  const date = new Date(0);
  expect(json.deepEqual({ date }, { date })).toBe(true);
});

describe("toJsonValue", () => {
  test("keeps plain data and drops undefined fields", () => {
    expect(json.from({ a: [1, "x", true, null], b: undefined, c: { d: 1 } })).toEqual({ a: [1, "x", true, null], c: { d: 1 } });
  });

  test("names the path that isn't plain data", () => {
    expect(() => json.from({ a: [{ b: new Date() }] }, "config")).toThrow("config.a[0].b is not plain data");
    expect(() => json.from({ n: Number.NaN })).toThrow("value.n is not a finite number");
    expect(() => json.from({ f: () => 1 })).toThrow("value.f is not plain data (function)");
  });
});

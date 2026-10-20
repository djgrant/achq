import { describe, expect, test } from "bun:test";
import { deepEqual, isPlainObject, sameJson, stableStringify, toJsonValue } from "../src/json.ts";

test("stableStringify sorts keys at every depth", () => {
  expect(stableStringify({ b: 1, a: [{ d: 2, c: null }] })).toBe(`{"a":[{"c":null,"d":2}],"b":1}`);
  expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
});

test("isPlainObject accepts literals and null-prototype objects only", () => {
  expect(isPlainObject({})).toBe(true);
  expect(isPlainObject(Object.create(null))).toBe(true);
  expect(isPlainObject([])).toBe(false);
  expect(isPlainObject(new Date())).toBe(false);
  expect(isPlainObject(null)).toBe(false);
});

test("deepEqual compares plain data structurally and anything else by identity", () => {
  expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(deepEqual([1, 2], [1])).toBe(false);
  expect(deepEqual(new Date(0), new Date(0))).toBe(false);
  const date = new Date(0);
  expect(deepEqual({ date }, { date })).toBe(true);
});

describe("toJsonValue", () => {
  test("keeps plain data and drops undefined fields", () => {
    expect(toJsonValue({ a: [1, "x", true, null], b: undefined, c: { d: 1 } })).toEqual({ a: [1, "x", true, null], c: { d: 1 } });
  });

  test("names the path that isn't plain data", () => {
    expect(() => toJsonValue({ a: [{ b: new Date() }] }, "config")).toThrow("config.a[0].b is not plain data");
    expect(() => toJsonValue({ n: Number.NaN })).toThrow("value.n is not a finite number");
    expect(() => toJsonValue({ f: () => 1 })).toThrow("value.f is not plain data (function)");
  });
});

import { expect, test } from "bun:test";
import { Env } from "../src/env.ts";

test("an empty variable counts as unset", () => {
  expect(new Env({ A: "" }).optional("A")).toBeUndefined();
  expect(new Env({ A: "x" }).optional("A")).toBe("x");
});

test("positiveInt is a whole number above 0, its fallback when unset, and throws on anything else", () => {
  expect(new Env({ N: "3" }).positiveInt("N", 2)).toBe(3);
  expect(new Env({}).positiveInt("N", 2)).toBe(2);
  expect(new Env({ N: "" }).positiveInt("N", 2)).toBe(2);
  for (const bad of ["0", "-1", "1.5", "abc", "1e3", "0x10"]) expect(() => new Env({ N: bad }).positiveInt("N", 2)).toThrow(`N must be a whole number above 0, not "${bad}".`);
});

test("require names what's missing and how to set it", () => {
  expect(new Env({ A: "x" }).require("A")).toBe("x");
  expect(() => new Env({}).require("A")).toThrow("Missing A in the environment.");
  expect(() => new Env({ A: "" }).require("A", "Create one.")).toThrow("Missing A in the environment. Create one.");
});

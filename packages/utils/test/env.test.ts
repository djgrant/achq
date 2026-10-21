import { expect, test } from "bun:test";
import { Env } from "../src/env.ts";

test("an empty variable counts as unset", () => {
  expect(new Env({ A: "" }).optional("A")).toBeUndefined();
  expect(new Env({ A: "x" }).optional("A")).toBe("x");
});

test("require names what's missing and how to set it", () => {
  expect(new Env({ A: "x" }).require("A")).toBe("x");
  expect(() => new Env({}).require("A")).toThrow("Missing A in the environment.");
  expect(() => new Env({ A: "" }).require("A", "Create one.")).toThrow("Missing A in the environment. Create one.");
});

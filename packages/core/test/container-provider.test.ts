import { expect, test } from "bun:test";
import { containerOf, ENV } from "../src/index.ts";

test("containerOf names the container a spec's variables are, or nothing without both", () => {
  expect(containerOf({ [ENV.repo]: "o/r", [ENV.container]: "dev", OTHER: "x" })).toEqual({ repo: "o/r", name: "dev" });
  expect(containerOf({ [ENV.repo]: "o/r" })).toBeUndefined();
  expect(containerOf({})).toBeUndefined();
});

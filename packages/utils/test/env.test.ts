import { expect, test } from "bun:test";
import { optionalEnv, requireEnv } from "../src/env.ts";

test("an empty variable counts as unset", () => {
  expect(optionalEnv({ A: "" }, "A")).toBeUndefined();
  expect(optionalEnv({ A: "x" }, "A")).toBe("x");
});

test("requireEnv names what's missing and how to set it", () => {
  expect(requireEnv({ A: "x" }, "A")).toBe("x");
  expect(() => requireEnv({}, "A")).toThrow("Missing A in the environment.");
  expect(() => requireEnv({ A: "" }, "A", "Create one.")).toThrow("Missing A in the environment. Create one.");
});

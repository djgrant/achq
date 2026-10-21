import { expect, test } from "bun:test";
import { errors } from "../src/errors.ts";

test("errorMessage gives an Error's message and anything else as a string", () => {
  expect(errors.message(new Error("boom"))).toBe("boom");
  expect(errors.message("plain")).toBe("plain");
  expect(errors.message(42)).toBe("42");
  expect(errors.message(undefined)).toBe("undefined");
});

test("errorDetail gives the stack, which starts with the message", () => {
  expect(errors.detail(new Error("boom"))).toStartWith("Error: boom\n");
  const bare = new Error("no stack");
  bare.stack = undefined;
  expect(errors.detail(bare)).toBe("no stack");
  expect(errors.detail("plain")).toBe("plain");
});

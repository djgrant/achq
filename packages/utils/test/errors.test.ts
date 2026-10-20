import { expect, test } from "bun:test";
import { errorDetail, errorMessage } from "../src/errors.ts";

test("errorMessage gives an Error's message and anything else as a string", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage("plain")).toBe("plain");
  expect(errorMessage(42)).toBe("42");
  expect(errorMessage(undefined)).toBe("undefined");
});

test("errorDetail gives the stack, which starts with the message", () => {
  expect(errorDetail(new Error("boom"))).toStartWith("Error: boom\n");
  const bare = new Error("no stack");
  bare.stack = undefined;
  expect(errorDetail(bare)).toBe("no stack");
  expect(errorDetail("plain")).toBe("plain");
});

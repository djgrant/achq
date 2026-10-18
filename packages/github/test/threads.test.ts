import { expect, test } from "bun:test";
import { slugify } from "../src/runtime/threads.ts";

test("slugify", () => {
  expect(slugify("Fix: the Café's  broken (login) flow!")).toBe("fix-the-cafe-s-broken-login-flow");
  expect(slugify("a".repeat(39) + " bcd").length).toBeLessThanOrEqual(40);
  expect(slugify("a".repeat(39) + " bcd").endsWith("-")).toBe(false);
});

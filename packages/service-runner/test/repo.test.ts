import { expect, test } from "bun:test";
import { fillBranch } from "../src/features/repo.ts";

test("fillBranch fills thread vars and refuses unknown ones", () => {
  expect(fillBranch("docs/{number}-{title}", { number: "42", title: "fix-it" })).toBe("docs/42-fix-it");
  expect(() => fillBranch("x/{nope}", { number: "1" })).toThrow("{nope}");
});

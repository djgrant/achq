import { expect, test } from "bun:test";
import { alignedTable, escapeRegExp, plural } from "../src/text.ts";

test("alignedTable pads columns and trims line ends", () => {
  expect(alignedTable([["ID", "NAME"], ["1", "alpha"], ["200", "b"]])).toEqual(["ID   NAME", "1    alpha", "200  b"]);
  expect(alignedTable([])).toEqual([]);
});

test("plural picks by count", () => {
  expect(`1 ${plural(1, "repo")}`).toBe("1 repo");
  expect(`2 ${plural(2, "repo")}`).toBe("2 repos");
  expect(plural(2, "is", "are")).toBe("are");
  expect(plural(0, "is", "are")).toBe("are");
});

test("escapeRegExp matches the text literally", () => {
  expect(new RegExp(escapeRegExp("a.b*(c)[d]")).test("a.b*(c)[d]")).toBe(true);
  expect(new RegExp(`^${escapeRegExp("a.c")}$`).test("abc")).toBe(false);
});

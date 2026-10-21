import { expect, test } from "bun:test";
import { text } from "../src/text.ts";

test("alignedTable pads columns and trims line ends", () => {
  expect(text.alignedTable([["ID", "NAME"], ["1", "alpha"], ["200", "b"]])).toEqual(["ID   NAME", "1    alpha", "200  b"]);
  expect(text.alignedTable([])).toEqual([]);
});

test("plural picks by count", () => {
  expect(`1 ${text.plural(1, "repo")}`).toBe("1 repo");
  expect(`2 ${text.plural(2, "repo")}`).toBe("2 repos");
  expect(text.plural(2, "is", "are")).toBe("are");
  expect(text.plural(0, "is", "are")).toBe("are");
});

test("escapeRegExp matches the text literally", () => {
  expect(new RegExp(text.escapeRegExp("a.b*(c)[d]")).test("a.b*(c)[d]")).toBe(true);
  expect(new RegExp(`^${text.escapeRegExp("a.c")}$`).test("abc")).toBe(false);
});

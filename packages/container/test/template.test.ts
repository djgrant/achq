import { describe, expect, test } from "bun:test";
import { render } from "../src/template.ts";

describe("render", () => {
  test("fills variables, sections and inverted sections", () => {
    const template = "Hi {{user.name}}\n{{#items}}\n- {{label}}\n{{/items}}\n{{^items}}\nnone\n{{/items}}\nend";
    expect(render(template, { user: { name: "dj" }, items: [{ label: "a" }, { label: "b" }] })).toBe("Hi dj\n- a\n- b\nend");
    expect(render(template, { user: { name: "dj" }, items: [] })).toBe("Hi dj\nnone\nend");
  });
  test("never re-parses values", () => {
    expect(render("{{#c}}{{body}}{{/c}}", { c: [{ body: "{{secret}} {{#x}}" }], secret: "no" })).toBe("{{secret}} {{#x}}");
  });
});

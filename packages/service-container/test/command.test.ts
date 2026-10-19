import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/command.ts";

describe("parseCommand", () => {
  test("resumes by default", () => {
    expect(parseCommand("@claude what about leases?", "@claude")).toEqual({ mode: "resume", text: "what about leases?" });
  });
  test("parses /new and /compact anywhere after the mention", () => {
    expect(parseCommand("hey @claude /new  build it\nplease", "@claude")).toEqual({ mode: "new", text: "build it\nplease" });
    expect(parseCommand("@claude /compact focus on tests", "@claude")).toEqual({ mode: "compact", text: "focus on tests" });
  });
  test("doesn't mistake longer words for commands", () => {
    expect(parseCommand("@claude /newer idea", "@claude").mode).toBe("resume");
  });
});

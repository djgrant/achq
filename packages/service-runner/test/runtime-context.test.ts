import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tempDir } from "@achq/test-utils/temp-dir";
import { runtimeContext } from "../src/features/runtime-context.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runtimeContext", () => {
  test("reads files in .achq/ and refuses any that leave it", () => {
    const root = tempDir(dirs);
    const achq = path.join(root, ".achq");
    fs.mkdirSync(achq);
    fs.writeFileSync(path.join(achq, "prompt.md"), "in\n");
    fs.writeFileSync(path.join(root, "secret"), "out\n");
    const ctx = runtimeContext(achq, { home: root, runnerPrompt: "", containerFiles: {}, env: {} });
    expect(ctx.readFile("./prompt.md")).toBe("in\n");
    expect(ctx.resolveFiles({ "~/a": "./prompt.md", "~/b": { x: 1 } })).toEqual({ "~/a": "in\n", "~/b": '{\n  "x": 1\n}\n' });
    expect(() => ctx.readFile("../secret")).toThrow("outside .achq/");
    expect(() => ctx.readFile(path.join(root, "secret"))).toThrow("outside .achq/");
    expect(() => ctx.resolveFiles({ "~/a": "../secret" })).toThrow("outside .achq/");
  });
});

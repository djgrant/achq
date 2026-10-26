import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMMANDS } from "../commands.ts";

test("commands.ts lists every command in commands/, by its file's name", async () => {
  const dir = path.join(import.meta.dir, "..", "commands");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  expect(Object.keys(COMMANDS).sort()).toEqual(files.map((f) => f.replace(/\.ts$/, "")).sort());
  for (const file of files) expect(COMMANDS[file.replace(/\.ts$/, "")]).toBe((await import(path.join(dir, file))).command);
});

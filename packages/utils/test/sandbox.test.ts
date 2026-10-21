import { describe, expect, test } from "bun:test";
import { sandbox } from "../src/sandbox.ts";

describe("run", () => {
  test("modules import each other by relative path, and the entry's default export comes back", async () => {
    const modules = {
      "/app/main.js": `import { n } from "./lib/n.js"; import { twice } from "../shared/twice.js"; export default String(twice(n));`,
      "/app/lib/n.js": `export const n = 21;`,
      "/shared/twice.js": `export const twice = (x) => x * 2;`,
    };
    expect(await sandbox.run("/app/main.js", { modules })).toEqual({ result: "42", logs: [] });
  });

  test("a module that isn't given doesn't exist, and the error names who imported what", async () => {
    await expect(sandbox.run("/main.js", { modules: { "/main.js": `import "./gone.js"; export default "x";` } })).rejects.toThrow(`/main.js imports "./gone.js", which doesn't exist`);
    await expect(sandbox.run("/main.js", { modules: { "/main.js": `import fs from "node:fs"; export default "x";` } })).rejects.toThrow(`imports "node:fs"`);
  });

  test("a custom resolver decides what a specifier means", async () => {
    const modules = { "/main.js": `import { v } from "lib"; export default v;`, "/vendor/lib.js": `export const v = "from lib";` };
    expect((await sandbox.run("/main.js", { modules, resolve: (s) => (s === "lib" ? "/vendor/lib.js" : undefined) })).result).toBe("from lib");
  });

  test("top-level await settles before the result is read; one that never settles is reported", async () => {
    expect((await sandbox.run("/main.js", { modules: { "/main.js": `const v = await Promise.resolve("later"); export default v;` } })).result).toBe("later");
    await expect(sandbox.run("/main.js", { modules: { "/main.js": `await new Promise(() => {}); export default "x";` } })).rejects.toThrow("never finished");
    await expect(sandbox.run("/main.js", { modules: { "/main.js": `await Promise.reject(new Error("no")); export default "x";` } })).rejects.toThrow("threw: Error: no");
  });

  test("the result must be a string, within the size limit", async () => {
    await expect(sandbox.run("/main.js", { modules: { "/main.js": `export default { a: 1 };` } })).rejects.toThrow("returned an object, not a string");
    await expect(sandbox.run("/main.js", { modules: { "/main.js": `export const a = 1;` } })).rejects.toThrow("returned nothing, not a string");
    await expect(sandbox.run("/main.js", { modules: { "/main.js": `export default "x".repeat(101);` }, limits: { maxResultBytes: 100 } })).rejects.toThrow("more than 100 bytes");
  });

  test("console output comes back as lines", async () => {
    const { logs } = await sandbox.run("/main.js", { modules: { "/main.js": `console.log("a", { b: 1 }); console.error(2); export default "";` } });
    expect(logs).toEqual([`a {"b":1}`, "2"]);
  });

  test("each run starts fresh: globals set by one aren't seen by the next", async () => {
    await sandbox.run("/main.js", { modules: { "/main.js": `globalThis.leftover = "yes"; export default "";` } });
    expect((await sandbox.run("/main.js", { modules: { "/main.js": `export default typeof globalThis.leftover;` } })).result).toBe("undefined");
  });
});

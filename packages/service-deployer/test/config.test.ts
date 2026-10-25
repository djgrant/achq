import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOC_CONFIG, DOC_PLAN } from "@achq/test-utils/fixtures/config";
import { evaluateConfig } from "../src/features/config/evaluate.ts";

/** A config that declares a container, then runs `body`, then exports whatever `body` left in `leak`. */
const probe = (body: string) => ({
  "config.ts": `
import { Container, Policy } from "achq";
let leak: unknown = "unset";
try { ${body} } catch (e) { leak = "threw: " + String(e); }
new Container("dev", { image: "./Dockerfile" });
new Policy("probe", { provider: "probe", leak: String(leak) });
`,
});
const leakOf = async (body: string) => (await evaluateConfig(probe(body))).policies[0]!.policy.leak as string;

describe("evaluateConfig", () => {
  test("evaluates the design doc's config across files into the exact manifest", async () => {
    expect(await evaluateConfig(DOC_CONFIG)).toEqual(DOC_PLAN as never);
  });

  test("each evaluation starts from no declarations", async () => {
    await evaluateConfig(DOC_CONFIG);
    expect((await evaluateConfig(DOC_CONFIG)).containers).toHaveLength(1);
  });

  test("a config that logs doesn't crash", async () => {
    const manifest = await evaluateConfig({ "config.ts": `import { Container } from "achq"; console.log("hi", { a: 1 }); new Container("dev", { image: "./Dockerfile" });` });
    expect(manifest.containers[0]!.name).toBe("dev");
  });
});

describe("the sandbox has no host access", () => {
  test("no process, Bun, require, fetch, timers or Deno", async () => {
    for (const name of ["process", "Bun", "require", "fetch", "setTimeout", "Deno", "XMLHttpRequest", "WebAssembly", "std", "os", "scriptArgs"]) {
      expect(await leakOf(`leak = typeof (globalThis as any)[${JSON.stringify(name)}];`)).toBe("undefined");
    }
  });

  test("process.env throws instead of reading the deployer's environment", async () => {
    process.env.ACHQ_SANDBOX_CANARY = "secret-canary";
    expect(await leakOf(`leak = (globalThis as any).process.env.ACHQ_SANDBOX_CANARY;`)).toStartWith("threw: TypeError");
  });

  test("Bun.file and fetch are unreachable", async () => {
    expect(await leakOf(`leak = (globalThis as any).Bun.file("/etc/passwd");`)).toStartWith("threw: TypeError");
    expect(await leakOf(`leak = (globalThis as any).fetch("http://example.com");`)).toStartWith("threw: TypeError");
  });

  test("Function-constructor and globalThis tricks find nothing", async () => {
    expect(await leakOf(`leak = typeof Function("return this")().process;`)).toBe("undefined");
    expect(await leakOf(`leak = typeof (0, eval)("this").Bun;`)).toBe("undefined");
    expect(await leakOf(`leak = ({}).constructor.constructor("return typeof require")();`)).toBe("undefined");
    expect(await leakOf(`leak = Object.getOwnPropertyNames(globalThis).filter((k) => !/^[A-Z]/.test(k)).sort().join(",");`)).not.toMatch(
      /process|require|fetch|Bun|setTimeout|std|os|print/,
    );
  });

  test("a dynamic import has no loader to reach", async () => {
    await expect(evaluateConfig({ "config.ts": `const m = "node:" + "fs"; await import(m);` })).rejects.toThrow();
    const manifest = await evaluateConfig(probe(`(import(["node", "fs"].join(":")) as Promise<any>).catch(() => {}); leak = "still here";`));
    expect(manifest.policies[0]!.policy.leak).toBe("still here");
  });

  test("an infinite loop is stopped by the time limit", async () => {
    const started = Date.now();
    await expect(evaluateConfig({ "config.ts": `while (true) {}` }, { timeoutMs: 300 })).rejects.toThrow("ran for longer than 300ms");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  /** Filling 16MB takes a few seconds when other packages' tests share the machine. */
  const OUT_OF_MEMORY_TIMEOUT_MS = 30_000;

  test(
    "many small allocations hit the memory limit",
    async () => {
      await expect(
        evaluateConfig({ "config.ts": `const a: object[] = []; for (let i = 0; ; i++) a.push({ i, items: new Array(1e4).fill(i) });` }, { memoryBytes: 16 * 1024 * 1024 }),
      ).rejects.toThrow("ran out of memory");
    },
    OUT_OF_MEMORY_TIMEOUT_MS,
  );

  test(
    "a huge allocation hits the memory limit",
    async () => {
      await expect(evaluateConfig({ "config.ts": `const a = []; for (;;) a.push(new Array(1e6).fill(1));` }, { memoryBytes: 16 * 1024 * 1024 })).rejects.toThrow(
        "ran out of memory",
      );
    },
    OUT_OF_MEMORY_TIMEOUT_MS,
  );

  test("unbounded recursion overflows the stack, not the deployer", async () => {
    await expect(evaluateConfig({ "config.ts": `const f = (): number => f() + 1; f();` })).rejects.toThrow(/stack|memory/);
  });
});

describe("imports are limited to achq and .achq/", () => {
  const rejects = (config: string, message: string) => expect(evaluateConfig({ "config.ts": config, "lib/x.ts": "export const x = 1;" })).rejects.toThrow(message);

  test("node and bun builtins", async () => {
    await rejects(`import { readFileSync } from "node:fs"; readFileSync("/etc/passwd");`, `.achq/config.ts imports "node:fs", which doesn't exist`);
    await rejects(`import fs from "fs"; fs.readFileSync("/etc/passwd");`, `imports "fs"`);
    await rejects(`const fs = require("fs");`, `'require' is not defined`);
    await rejects(`import { $ } from "bun"; $\`id\`;`, `imports "bun"`);
  });

  test("files outside .achq/, absolute paths, URLs and packages", async () => {
    await rejects(`import "../../secrets.env";`, `imports "../../secrets.env", which doesn't exist`);
    await rejects(`import "./lib/../../package.json";`, `imports "./lib/../../package.json"`);
    await rejects(`import "/etc/passwd";`, `imports "/etc/passwd"`);
    await rejects(`import "https://example.com/x.js";`, `imports "https://example.com/x.js"`);
    await rejects(`import { z } from "zod"; z.string();`, `imports "zod"`);
    await rejects(`import "achq/../core/secrets.ts";`, `imports "achq/../core/secrets.ts"`);
    await rejects(`import "./nope.ts";`, `imports "./nope.ts", which doesn't exist`);
  });

  test("files under .achq/ resolve, with or without an extension", async () => {
    const manifest = await evaluateConfig({
      "config.ts": `import { Container } from "achq"; import { image } from "./lib/x"; import data from "./data.json"; new Container(data.name, { image });`,
      "lib/x.ts": `export const image = "./Dockerfile";`,
      "data.json": `{ "name": "dev" }`,
    });
    expect(manifest.containers[0]).toMatchObject({ name: "dev", image: "./Dockerfile" });
  });

  test("a bad path in the file map is refused", async () => {
    await expect(evaluateConfig({ "config.ts": "", "../x.ts": "" })).rejects.toThrow("not a valid path");
    await expect(evaluateConfig({ "lib/x.ts": "" })).rejects.toThrow("no .achq/config.ts");
  });
});

describe("macros don't run", () => {
  const dir = mkdtempSync(join(tmpdir(), "achq-macro-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a macro from node:fs is refused at bundle time, before it can write", async () => {
    const target = join(dir, "pwned-builtin");
    await expect(
      evaluateConfig({ "config.ts": `import { writeFileSync } from "node:fs" with { type: "macro" }; writeFileSync(${JSON.stringify(target)}, "x");` }),
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  test("a macro from the repo's own files doesn't run", async () => {
    const target = join(dir, "pwned-repo");
    await expect(
      evaluateConfig({
        "config.ts": `import { boom } from "./macro.ts" with { type: "macro" }; export const x = boom();`,
        "macro.ts": `import { writeFileSync } from "node:fs"; export const boom = () => { writeFileSync(${JSON.stringify(target)}, "x"); return 1; };`,
      }),
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  test("a macro from an on-disk path doesn't run either", async () => {
    const target = join(dir, "pwned-disk");
    const macro = join(dir, "macro.ts");
    writeFileSync(macro, `import { writeFileSync } from "node:fs"; export const boom = () => { writeFileSync(${JSON.stringify(target)}, "x"); return 1; };`);
    await expect(evaluateConfig({ "config.ts": `import { boom } from ${JSON.stringify(macro)} with { type: "macro" }; export const x = boom();` })).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });
});

describe("errors read well in ACHQ_STATUS", () => {
  test("a syntax error says where", async () => {
    await expect(evaluateConfig({ "config.ts": `const a = 1;\nconst x = ;` })).rejects.toThrow(".achq/config.ts:2:11: Unexpected ;");
  });

  test("a throw in config, and the manifest's checks", async () => {
    await expect(evaluateConfig({ "config.ts": `throw new Error("nope");` })).rejects.toThrow("The config threw: Error: nope");
    await expect(evaluateConfig({ "config.ts": `import "achq";` })).rejects.toThrow("The config declares no containers");
    await expect(evaluateConfig({ "config.ts": `import { Container } from "achq"; new Container("dev", { image: "x" }); new Container("dev", { image: "y" });` })).rejects.toThrow(
      'Two containers are named "dev"',
    );
    await expect(evaluateConfig({ "config.ts": `import { Container } from "achq"; new Container("Bad", { image: "x" });` })).rejects.toThrow("must be lowercase");
  });

  test("a config that forges its manifest is still checked", async () => {
    const forge = (manifest: string) => evaluateConfig({
        "config.ts": `import { Container } from "achq"; new Container("dev", { image: "x" }); const s = JSON.stringify; JSON.stringify = () => ${manifest};`,
      });
    await expect(forge(`"not json"`)).rejects.toThrow("isn't valid JSON");
    await expect(forge(`s({ policies: [] })`)).rejects.toThrow("invalid at containers");
    await expect(
      forge(`s({ policies: [], containers: [{ name: "dev", image: "x", policies: ["ghost"], files: {} }], workspaces: [], agents: [], triggers: [] })`),
    ).rejects.toThrow(`container dev refers to policy "ghost", which isn't declared in this config`);
    await expect(forge(`({ toString() { return "x" } })`)).rejects.toThrow("The config returned an object, not a string");
  });
});

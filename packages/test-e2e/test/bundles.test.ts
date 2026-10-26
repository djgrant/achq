// The services' bundles, which are what they publish, work on their own: each is copied
// somewhere with no node_modules to fall back on, and run from there.
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { evaluateConfig } from "@achq/deployer/config";
import { DOC_CONFIG, DOC_PLAN } from "@achq/test-utils/fixtures/config";
import { workspaceConfigModules } from "@achq/test-utils/helpers/plugins";
import { BUNDLES, bundle } from "../../../scripts/bundle.ts";

/** Each package's dist/, copied out of the workspace. */
const dists: Record<string, string> = {};
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "achq-bundles-"));
  for (const b of BUNDLES) {
    dists[b.dir] = path.join(tmp, b.dir);
    fs.cpSync(await bundle(b), dists[b.dir]!, { recursive: true });
  }
}, 60_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BUILTIN = (specifier: string) => specifier === "bun" || specifier.startsWith("bun:") || specifier.startsWith("node:") || builtinModules.includes(specifier);

test("a bundle imports nothing but Bun's and Node's built-ins", () => {
  for (const dir of Object.values(dists)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const code = fs.readFileSync(path.join(dir, file), "utf8").replace(/^#!.*\n/, "");
      const imports = new Bun.Transpiler({ loader: "js" }).scanImports(code).map((i) => i.path);
      expect({ file, imports: imports.filter((i) => !BUILTIN(i)) }).toEqual({ file, imports: [] });
    }
  }
});

test("each bin runs from its bundle alone, as far as reading its environment", async () => {
  const bins = { "service-router": ["achq-router.js", "ACHQ_PLUGINS"], "service-deployer": ["achq-deployer.js", "AGENT_WEBHOOK_KEY"], "service-runner": ["achq-runner", "ACHQ_REPO"] };
  for (const [dir, [bin, first]] of Object.entries(bins)) {
    const proc = Bun.spawn([path.join(dists[dir]!, bin!)], { cwd: tmp, env: { PATH: process.env.PATH!, DATA_DIR: path.join(tmp, "data") }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(stderr).toContain(`Missing ${first} in the environment.`);
  }
});

test("the deployer's config bundle evaluates a config in the sandbox, with QuickJS's WebAssembly beside it", async () => {
  const config = (await import(path.join(dists["service-deployer"]!, "config.js"))) as { evaluateConfig: typeof evaluateConfig };
  expect(await config.evaluateConfig(DOC_CONFIG, workspaceConfigModules())).toEqual(DOC_PLAN as never);
});

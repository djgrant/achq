// The published packages, as npm has them: each package's bundle is packed as `pok publish` packs it,
// unpacked where nothing else is installed, and used as the services, containers, CLI and your editor use it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { configModules, loadPlugins } from "@achq/core/plugins";
import { evaluateConfig } from "@achq/deployer/config";
import { bundleConfig, evaluateBundle } from "../../service-runner/src/features/config.ts";
import { DOC_CONFIG, DOC_PLAN } from "@achq/test-utils/fixtures/config";
import { CONTAINER_PLUGINS } from "@achq/test-utils/helpers/plugins";
import { bundle, PACKAGES } from "../../../scripts/bundle.ts";

const ROOT = path.join(import.meta.dir, "..", "..", "..");

type Manifest = { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; bin?: Record<string, string> };

let tmp: string;
/** Each published package's tarball, by its name. */
const tarballs: Record<string, string> = {};
/** Each published package as npm has it, unpacked, by its name. */
const packed: Record<string, string> = {};
const manifestOf = (name: string): Manifest => JSON.parse(fs.readFileSync(path.join(packed[name]!, "package.json"), "utf8"));

const unpack = async (name: string, dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const tar = Bun.spawn(["tar", "-xzf", tarballs[name]!, "-C", dir, "--strip-components=1"]);
  if ((await tar.exited) !== 0) throw new Error(`Unpacking ${name} failed`);
};

/** `dir/node_modules` with `names` in it, as an install of them leaves it: they need nothing else. */
const install = async (dir: string, names: string[]) => {
  for (const name of names) await unpack(name, path.join(dir, "node_modules", name));
};

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "achq-bundles-")));
  for (const p of PACKAGES) {
    await bundle(p);
    const proc = Bun.spawn(["pnpm", "pack", "--pack-destination", path.join(tmp, "tarballs")], { cwd: path.join(ROOT, "packages", p.dir), stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`Packing ${p.dir} failed: ${await new Response(proc.stderr).text()}`);
    const { name } = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", p.dir, "package.json"), "utf8")) as Manifest;
    tarballs[name] = path.join(tmp, "tarballs", (await new Response(proc.stdout).text()).trim().split("\n").at(-1)!.split("/").at(-1)!);
    packed[name] = path.join(tmp, "packed", name);
    await unpack(name, packed[name]!);
  }
}, 240_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a published package depends on no package but achq's own, and a plugin takes core as its peer", () => {
  for (const name of Object.keys(packed)) {
    const { dependencies = {}, peerDependencies = {} } = manifestOf(name);
    expect({ name, others: Object.keys({ ...dependencies, ...peerDependencies }).filter((d) => !(d in packed)) }).toEqual({ name, others: [] });
  }
  expect(manifestOf("@achq/github").peerDependencies).toEqual({ "@achq/core": expect.stringMatching(/^\^/) });
});

test("a bundle imports nothing but its runtime's modules and the achq packages it depends on", () => {
  const builtin = (s: string) => s === "bun" || s.startsWith("bun:") || s.startsWith("node:") || s.startsWith("cloudflare:") || builtinModules.includes(s);
  for (const [name, dir] of Object.entries(packed)) {
    const { dependencies = {}, peerDependencies = {} } = manifestOf(name);
    for (const file of fs.readdirSync(path.join(dir, "dist")).filter((f) => f.endsWith(".js"))) {
      const code = fs.readFileSync(path.join(dir, "dist", file), "utf8").replace(/^#!.*\n/, "");
      const imports = new Bun.Transpiler({ loader: "js" }).scanImports(code).map((i) => i.path);
      const others = imports.filter((i) => !builtin(i) && !i.startsWith("./") && !(i in dependencies) && !(i in peerDependencies));
      expect({ file: `${name}/${file}`, others }).toEqual({ file: `${name}/${file}`, others: [] });
    }
  }
});

test("each service's bin runs from its bundle alone, as far as reading its environment", async () => {
  const bins = { "@achq/router": "ACHQ_PLUGINS", "@achq/deployer": "AGENT_WEBHOOK_KEY", "@achq/runner": "ACHQ_REPO" };
  for (const [name, first] of Object.entries(bins)) {
    const bin = Object.values(manifestOf(name).bin!)[0]!;
    const proc = Bun.spawn([path.join(packed[name]!, bin)], { cwd: tmp, env: { PATH: process.env.PATH!, DATA_DIR: path.join(tmp, "data") }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(stderr).toContain(`Missing ${first} in the environment.`);
  }
});

test("the CLI runs from its bundle", async () => {
  const cli = path.join(tmp, "cli");
  await install(cli, ["@achq/cli", "@achq/core", "@achq/github"]);
  const proc = Bun.spawn([path.join(cli, "node_modules", "@achq/cli", manifestOf("@achq/cli").bin!.achq!), "--help"], { cwd: tmp, env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(stdout).toContain("infra");
  expect(stdout).toContain("repo");
});

test("a plugins dir of the bundles loads each plugin's providers, as a service does, and configs evaluate against it in the deployer's sandbox and the runner", async () => {
  const dir = path.join(tmp, "plugins");
  const plugins = [...CONTAINER_PLUGINS, { package: "@achq/railway", version: "0" }, { package: "@achq/cloudflare", version: "0" }];
  // As bun install leaves it: each plugin, and core, their peer.
  const providers = await loadPlugins(plugins, dir, { install: (d) => install(d, ["@achq/core", ...plugins.map((p) => p.package), "@achq/cloudflare-worker"]) });
  expect(providers.containers.map((c) => c.id).sort()).toEqual(["cloudflare", "railway"]);
  expect(providers.channels.map((c) => c.id)).toEqual(["github"]);
  expect(providers.agents.map((a) => a.id)).toEqual(["claude"]);

  const modules = configModules(CONTAINER_PLUGINS, dir);
  expect(modules["@achq/core"]).toStartWith(path.join(dir, "node_modules", "@achq/core", "dist"));
  // The deployer's sandbox builds core and the plugins as published.
  expect(await evaluateConfig(DOC_CONFIG, modules)).toEqual(DOC_PLAN as never);
  // The runner bundles the config against them, and reads what it declared from its own copy of core.
  const config = path.join(tmp, "config");
  for (const [file, contents] of Object.entries(DOC_CONFIG)) {
    fs.mkdirSync(path.dirname(path.join(config, file)), { recursive: true });
    fs.writeFileSync(path.join(config, file), contents);
  }
  const { manifest, agents } = await evaluateBundle(await bundleConfig(config, path.join(tmp, "config-bundle"), modules));
  expect(manifest).toEqual(DOC_PLAN as never);
  expect(agents.map((a) => a.name).sort()).toEqual(DOC_PLAN.agents.map((a) => a.name).sort());
}, 60_000);

test("a repo's config and the infra's files typecheck against the published declarations", async () => {
  const project = path.join(tmp, "typed");
  await install(project, ["@achq/core", "@achq/github", "@achq/claude", "@achq/railway", "@achq/cloudflare", "@achq/1password"]);
  const files: Record<string, string> = {
    ...Object.fromEntries(Object.entries(DOC_CONFIG).map(([file, contents]) => [path.join(".achq", file), contents])),
    "railway.infra.ts": `
import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";

export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  new railway.Deployer("deployer", { router, owners: ["djgrant"] });
  new github.CodeHost("github");
  new github.Channel("personal", { name: "djgrant-claude", router });
  new claude.AgentRuntime("claude");
});
`,
    "cloudflare.infra.ts": `
import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as cloudflare from "@achq/cloudflare/infra";
import * as github from "@achq/github/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", { project: "achq" });
  new cloudflare.Deployer("deployer", { router, owners: ["djgrant"], sshKeys: ["ssh-ed25519 AAAA me@laptop"] });
  new github.CodeHost("github");
  new github.Channel("personal", { name: "djgrant-claude", router });
  new claude.AgentRuntime("claude");
});
`,
    "achq.config.ts": `
import * as onepassword from "@achq/1password";

export default { vault: onepassword.vault("achq") };
`,
    // Declarations are checked too: one that names a type it can't find fails. The web's types, e.g. Headers, are in TypeScript's default lib.
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "ESNext", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext", "DOM"], types: [], allowImportingTsExtensions: true, noEmit: true, skipLibCheck: false },
      include: ["**/*.ts"],
    }),
  };
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), contents);
  }
  const tsc = Bun.spawn([path.join(ROOT, "node_modules", ".bin", "tsc"), "-p", project], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(tsc.stdout).text();
  expect(output).toBe("");
  expect(await tsc.exited).toBe(0);
}, 60_000);

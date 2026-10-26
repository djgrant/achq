import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "../src/index.ts";
import { context } from "../src/engine/context.ts";

beforeEach(core.resetDeclarations);

const plugin = (name: string, version = "1.0.0") => ({ package: name, version });

/** A plain resource of `kind` from `from`, with `role` if it has one. */
const declare = (name: string, kind: string, from: core.Plugin, role?: string) =>
  new (class extends core.Resource {
    readonly kind = kind;
    readonly plugin = from;
    readonly role = role;
  })(name);

test("each plugin is loaded where its resources are used: the services load all but runtimes, containers channels, policies and runtimes", () => {
  const github = plugin("@achq/github");
  const railway = plugin("@achq/railway");
  const claude = plugin("@achq/claude");
  const resources = [
    declare("router", "router", railway),
    declare("deployer", "deployer", railway),
    declare("personal", "github-channel", github, "channel"),
    declare("notation", "github-channel", github, "channel"),
    declare("github", "code-host", github),
    declare("claude", "agent-runtime", claude),
    // Core's own resources come with every process.
    declare("dev", "container", core.CORE_PLUGIN),
  ];
  expect(core.pluginsOf(resources)).toEqual({ services: [railway, github], containers: [github, claude] });
});

test("one package at two versions can't be installed side by side", () => {
  expect(() => core.pluginsOf([declare("a", "router", plugin("@achq/railway", "1.0.0")), declare("b", "deployer", plugin("@achq/railway", "1.1.0"))])).toThrow(
    "@achq/railway is declared at both 1.0.0 and 1.1.0",
  );
});

test("plugins' providers merge, and are found by id, with privateEnv over all of them once each", () => {
  const channel = { id: "github", create: () => ({}) as never, privateEnv: ["GITHUB_KEY"] };
  const policy = { id: "github", create: () => ({}) as never, privateEnv: ["GITHUB_KEY"] };
  const container = { id: "railway", create: () => ({}) as never, store: () => ({}) as never, privateEnv: ["RAILWAY_API_TOKEN"] };
  const merged = core.mergeProviders([{ channels: [channel], policies: [policy] }, { containers: [container] }]);
  expect(core.providerNamed("channel provider", merged.channels, "github")).toBe(channel);
  expect(() => core.providerNamed("channel provider", merged.channels, "slack")).toThrow(`achq doesn't know the channel provider "slack"; it knows github`);
  expect(() => core.onlyCodeHost(merged)).toThrow("An infra has one code host; the plugins loaded provide 0");
  expect(core.privateEnv(merged)).toEqual(["ACHQ_CONTAINER_SECRET", "AGENT_WEBHOOK_KEY", "GITHUB_KEY", "RAILWAY_API_TOKEN"]);
});

// ── Two copies of core in one process ──

/** A second copy of core's source, beside this one, so it resolves `@achq/utils` as core does: as a CLI installed globally and an infra repo each have one. */
const SECOND = path.join(import.meta.dir, "..", ".second-core");
let second: typeof core;
beforeAll(async () => {
  fs.rmSync(SECOND, { recursive: true, force: true });
  fs.cpSync(path.join(import.meta.dir, "..", "src"), path.join(SECOND, "src"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dir, "..", "package.json"), path.join(SECOND, "package.json"));
  second = await import(path.join(SECOND, "src", "index.ts"));
});
afterAll(() => fs.rmSync(SECOND, { recursive: true, force: true }));

test("a resource declared through another copy of core is planned and applied by this one, its outputs and unknowns understood", async () => {
  expect(second.ManagedResource).not.toBe(core.ManagedResource);
  const rows = new Map<string, string>();

  /** A row made with the other copy's classes, as a plugin in the infra repo makes its resources. */
  class Row extends second.ManagedResource<{ value: string }, { value: string }, { id: string }, "create"> {
    readonly plugin = plugin("@achq/rows");
    readonly kind = "row";
    async read() {
      return rows.has(this.name) ? { value: rows.get(this.name)! } : undefined;
    }
    diff(_: unknown, current: unknown) {
      return current ? [] : ["create" as const];
    }
    describe(): core.Change {
      return { op: "+", target: this.name, what: "row" };
    }
    planned(_: unknown, current: unknown): core.Planned<{ id: string }> {
      return { id: current ? `id-${this.name}` : second.UNKNOWN };
    }
    async apply(props: { value: string }) {
      rows.set(this.name, props.value);
      return { id: `id-${this.name}` };
    }
  }

  const first = new Row("first", { value: "a" });
  const after = new Row("after", { value: first.out("id") });
  // One list of declarations, and one UNKNOWN, whichever copy is asked.
  expect(core.declared()).toEqual([first, after]);
  expect(second.UNKNOWN).toBe(core.UNKNOWN);
  expect(core.isOutput(first.out("id"))).toBe(true);
  expect(core.isManaged(first)).toBe(true);

  const planned = await core.plan(core.declared(), context({ env: {} }));
  expect(planned.changes.map((c) => c.target)).toEqual(["first", "after"]);
  expect(core.known(planned.value(first.out("id")))).toBe(false);
  const applied = await planned.apply();
  expect(applied.value(after.out("id"))).toBe("id-after");
  expect(rows).toEqual(new Map([["first", "a"], ["after", "id-first"]]));
});

test("core's classes are recognised by brand across copies, and a lookalike isn't", () => {
  const container = new second.Container("dev", { image: "./Dockerfile" });
  expect(core.isContainer(container)).toBe(true);
  expect(container instanceof core.Container).toBe(false);
  expect(core.collectManifest().containers.map((c) => c.name)).toEqual(["dev"]);
  expect(core.isContainer({ kind: "container", name: "dev" })).toBe(false);
});

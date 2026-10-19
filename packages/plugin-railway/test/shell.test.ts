import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { railwayShell } from "../src/container-hosts/shell.ts";

const location = { containerHost: "railway", project: "p1", environment: "e1", service: "notationlabs-yieldstar-dev" };

// A `railway` CLI that prints its arguments, and fails when asked to. Bun
// finds commands on the PATH it started with, so the shell runs in a child
// process whose PATH has it first.
let bin: string;
beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "achq-railway-"));
  fs.writeFileSync(path.join(bin, "railway"), `#!/bin/sh\necho "$@"\n[ "$9" = fail ] && { echo broke >&2; exit 1; }\nexit 0\n`, { mode: 0o755 });
});
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

const run = async (command: string[]) => {
  const shell = path.join(import.meta.dir, "../src/container-hosts/shell.ts");
  const script = `const { railwayShell } = await import(${JSON.stringify(shell)});
try { process.stdout.write(await railwayShell.run(${JSON.stringify(location)}, ${JSON.stringify(command)})); } catch (e) { process.stdout.write(String(e)); }`;
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe" });
  return new Response(proc.stdout).text();
};

test("ssh targets the container's project, environment and service", async () => {
  expect(await run(["ls", "/data"])).toBe("ssh --project p1 --environment e1 --service notationlabs-yieldstar-dev -- ls /data\n");
  expect(await run(["fail"])).toBe("Error: fail failed in notationlabs-yieldstar-dev: broke");
});

test("a location without a project, environment and service can't be reached", () => {
  expect(railwayShell.reachable(location)).toBe(true);
  expect(railwayShell.reachable({ containerHost: "railway", project: "p1" })).toBe(false);
});

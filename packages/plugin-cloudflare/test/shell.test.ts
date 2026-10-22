import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cloudflareShell } from "../src/container/provider.ts";

const location = { containerProvider: "cloudflare", account: "acct", worker: "achq-notationlabs-yieldstar-dev", application: "app-1" };

// An `npx` that answers `wrangler containers instances` with one running
// instance, and prints its arguments and account otherwise, failing when asked
// to. Bun finds commands on the PATH it started with, so the shell runs in a
// child process whose PATH has it first.
let bin: string;
beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "achq-cloudflare-"));
  const npx = `#!/bin/sh
case "$*" in *"containers instances"*) echo '[{"id":"stopped-1","state":"stopped"},{"id":"inst-1","state":"running"}]'; exit 0;; esac
echo "$CLOUDFLARE_ACCOUNT_ID $@"
for a; do :; done
[ "$a" = fail ] && { echo broke >&2; exit 1; }
exit 0
`;
  fs.writeFileSync(path.join(bin, "npx"), npx, { mode: 0o755 });
});
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

const run = async (command: string[]) => {
  const shell = path.join(import.meta.dir, "../src/container/provider.ts");
  const script = `const { cloudflareShell } = await import(${JSON.stringify(shell)});
try { process.stdout.write(await cloudflareShell.run(${JSON.stringify(location)}, ${JSON.stringify(command)})); } catch (e) { process.stdout.write(String(e)); }`;
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe" });
  return new Response(proc.stdout).text();
};

test("ssh runs the command in the application's running instance, with the container's environment", async () => {
  expect(await run(["achq-agent", "sessions"])).toBe(`acct -y wrangler@4 containers ssh inst-1 -- sh -c set -a; . /run/achq/env; exec "$@" sh achq-agent sessions\n`);
  expect(await run(["fail"])).toBe("Error: fail failed in achq-notationlabs-yieldstar-dev: broke");
});

test("a location without its account, Worker and application can't be reached", () => {
  expect(cloudflareShell.reachable(location)).toBe(true);
  expect(cloudflareShell.reachable({ containerProvider: "cloudflare", account: "acct", worker: "w" })).toBe(false);
});

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMMANDS, OLD_RUNNER_BINARY, RUNNER_BINARY, resume, serve, sessions } from "../src/wire/commands.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("each command's argv starts with the runner's binary and the name it dispatches on", () => {
  expect(RUNNER_BINARY).toBe("achq-runner");
  expect(sessions()).toEqual([RUNNER_BINARY, COMMANDS.sessions]);
  expect(sessions("34")).toEqual([RUNNER_BINARY, COMMANDS.sessions, "34"]);
  expect(resume("34", "aaa111")).toEqual([RUNNER_BINARY, COMMANDS.resume, "34", "aaa111"]);
});

test("an older container's binary can be named instead", () => {
  expect(sessions("34", OLD_RUNNER_BINARY)).toEqual(["achq-agent", COMMANDS.sessions, "34"]);
  expect(resume("34", "aaa111", OLD_RUNNER_BINARY)).toEqual(["achq-agent", COMMANDS.resume, "34", "aaa111"]);
});

test("serve starts achq-runner, or achq-agent in an image an older install.sh built", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "achq-serve-"));
  dirs.push(bin);
  const binary = (name: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} "$@"\n`, { mode: 0o755 });
  const started = async () => {
    const proc = Bun.spawn(serve(), { env: { PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe" });
    return (await new Response(proc.stdout).text()).trim();
  };
  binary(OLD_RUNNER_BINARY);
  expect(await started()).toBe("achq-agent");
  binary(RUNNER_BINARY);
  expect(await started()).toBe("achq-runner");
});

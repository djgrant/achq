import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, runUnderEnv } from "../src/lib/load/config.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "achq-config-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const writeConfig = (body: string) => fs.writeFileSync(path.join(tmp, "achq.config.ts"), body);

test("there's no config without the file", async () => {
  expect(await loadConfig(tmp)).toBeUndefined();
});

test("a config names the command to run under, and where it is", async () => {
  writeConfig(`export default { env: "env FOO=bar" };`);
  expect(await loadConfig(tmp)).toEqual({ env: "env FOO=bar", dir: tmp });
});

test("a config that isn't one says what's wrong", async () => {
  writeConfig(`export default { env: 1 };`);
  expect(loadConfig(tmp)).rejects.toThrow("env");
});

test("achq runs under the env command, from the config's directory, with its args intact", async () => {
  const out = path.join(tmp, "out");
  const code = await runUnderEnv({ env: "env FOO=bar", dir: tmp }, ["sh", "-c", `echo "$FOO $ACHQ_UNDER_ENV $PWD $1" > ${out}; exit 3`, "_", "two words"]);
  expect(code).toBe(3);
  expect(fs.readFileSync(out, "utf8").trim()).toBe(`bar 1 ${tmp} two words`);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { linkWorkspace } from "@achq/test-utils/helpers/plugins";
import { envFrom, loadConfig } from "../envs/config.ts";

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

test("a config can give a vault, from the vault plugin the repo installed", async () => {
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ dependencies: { "@achq/1password": "0.1.0" } }));
  await linkWorkspace(tmp);
  writeConfig(`import * as onepassword from "@achq/1password";\nexport default { vault: onepassword.vault("Infra") };`);
  const config = await loadConfig(tmp);
  expect(typeof config?.vault?.read).toBe("function");
  expect(typeof config?.vault?.write).toBe("function");
});

test("a vault named by its provider, as configs once did, isn't a vault", async () => {
  writeConfig(`export default { vault: { provider: "1password", name: "Infra" } };`);
  await expect(loadConfig(tmp)).rejects.toThrow('a vault, e.g. onepassword.vault("achq")');
});

test("a config that isn't one says what's wrong", async () => {
  writeConfig(`export default { env: 1 };`);
  expect(loadConfig(tmp)).rejects.toThrow("env");
});

test("achq takes on the env command's environment, set from the config's directory", async () => {
  const env = await envFrom({ env: "env FOO=bar HERE=$(pwd -P)", dir: tmp });
  expect([env.FOO, env.HERE]).toEqual(["bar", tmp]);
});

test("the environment arrives when the env command swallows what it runs prints, as op run's masking may", async () => {
  expect((await envFrom({ env: "env FOO=bar sh -c '\"$@\" > /dev/null' _", dir: tmp })).FOO).toBe("bar");
});

test("an env command that fails says so", async () => {
  await expect(envFrom({ env: "false", dir: tmp })).rejects.toThrow("`false` failed (exit 1)");
});

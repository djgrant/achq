// The router and deployer run on the stock Bun image. Their start command
// downloads achq at ACHQ_REF, installs its dependencies once, and runs the
// service's entry point.
import { ACHQ_SOURCE } from "@achq/core";

/**
 * Runs `entry` (e.g. `packages/router/src/main.ts`) from achq at ACHQ_REF.
 * The download and `bun install` go on the service's volume, so a wake doesn't
 * repeat them. The script must not contain single quotes, because Railway
 * splits the command like a shell.
 */
export const startCommand = (entry: string) => {
  const script = [
    `const fs = require("node:fs");`,
    `const ref = process.env.ACHQ_REF;`,
    `if (!ref) throw new Error("Missing ACHQ_REF");`,
    `const dir = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "/tmp") + "/achq/" + ref;`,
    `if (!fs.existsSync(dir)) {`,
    `  const res = await fetch("${ACHQ_SOURCE.archive}" + ref);`,
    `  if (!res.ok) throw new Error("achq " + ref + ": " + res.status);`,
    `  const tmp = dir + ".tmp";`,
    `  fs.rmSync(tmp, { recursive: true, force: true });`,
    `  fs.mkdirSync(tmp, { recursive: true });`,
    `  await Bun.write(tmp + ".tgz", res);`,
    `  const tar = Bun.spawnSync(["tar", "xzf", tmp + ".tgz", "-C", tmp, "--strip-components=1"]);`,
    `  if (!tar.success) throw new Error("tar: " + tar.stderr);`,
    `  fs.rmSync(tmp + ".tgz");`,
    `  fs.renameSync(tmp, dir);`,
    `}`,
    `if (!fs.existsSync(dir + "/node_modules")) {`,
    `  const install = Bun.spawnSync(["bun", "install", "--production", "--frozen-lockfile"], { cwd: dir, stdout: "inherit", stderr: "inherit" });`,
    `  if (!install.success) throw new Error("bun install failed");`,
    `}`,
    `const entry = await import(dir + "/${entry}");`,
    `if (typeof entry.main === "function") await entry.main();`,
  ].join(" ");
  return `bun -e '${script}'`;
};

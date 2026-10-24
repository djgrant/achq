import { ACHQ_SOURCE } from "../wire/constants.ts";

// The script runs in the service's own Bun, not here, so it's written as
// source. Its parts are joined with spaces into one line, and that line is in
// a deploy's fingerprint: changing a character redeploys every service.

/**
 * A Bun script that runs `entry` (e.g. `packages/service-router/src/main.ts`)
 * from achq at ACHQ_REF. `root` is a JS expression for where achq goes: a
 * directory a wake keeps, so it doesn't download it again. `timed` logs how
 * long downloading and installing took. It has no single quotes, so it can be
 * quoted for a shell.
 */
export const achqStartScript = (entry: string, { root, timed = false }: { root: string; timed?: boolean }) => {
  const started = timed ? [`  const started = Date.now();`] : [];
  const took = (what: string) => (timed ? [`  console.log("achq " + ref.slice(0, 7) + ": ${what} in " + (Date.now() - started) / 1000 + "s");`] : []);
  return [
    `const fs = require("node:fs");`,
    `const ref = process.env.ACHQ_REF;`,
    `if (!ref) throw new Error("Missing ACHQ_REF");`,
    `const root = ${root};`,
    `const dir = root + "/" + ref;`,
    // Downloads and unpacks it beside `dir`, then renames it into place, so an interrupted download is never taken for a finished one.
    `if (!fs.existsSync(dir)) {`,
    ...started,
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
    ...took("downloaded"),
    `}`,
    `if (!fs.existsSync(dir + "/node_modules")) {`,
    ...started,
    `  const install = Bun.spawnSync(["bun", "install", "--production", "--frozen-lockfile"], { cwd: dir, stdout: "inherit", stderr: "inherit" });`,
    `  if (!install.success) throw new Error("bun install failed");`,
    ...took("installed"),
    `}`,
    // Deletes every other ref once this one's ready: each is a copy of achq with its node_modules, which would otherwise pile up a push at a time.
    `for (const other of fs.readdirSync(root)) if (other !== ref) fs.rmSync(root + "/" + other, { recursive: true, force: true });`,
    `const entry = await import(dir + "/${entry}");`,
    `if (typeof entry.main === "function") await entry.main();`,
  ].join(" ");
};

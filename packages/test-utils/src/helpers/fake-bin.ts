import * as fs from "node:fs";
import * as path from "node:path";

/** `s` as one word of a shell command, whatever it holds. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A command `name` in `dir` that runs the script `source` with bun, passing
 * on its arguments. Returns the command's path. It's a shell wrapper, since
 * bun's path may have spaces a shebang can't hold.
 */
export const fakeBin = (dir: string, name: string, source: string) => {
  const bin = path.join(dir, name);
  const script = `${bin}.js`;
  fs.writeFileSync(script, source);
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  return bin;
};

import type { Shell } from "@achq/core";
import { subprocess } from "@achq/utils/subprocess";

/** A container, as the router reaches it: a shell in it, opened here or run to the end. */
export type Reachable = {
  name: string;
  /** An interactive shell, running `command` or a login shell. Returns its exit code. */
  open(command: string[]): Promise<number>;
  /** `command`'s output. Throws, with what it printed, if it fails. */
  run(command: string[]): Promise<string>;
};

/** What `shell` needs on your machine, checked before it runs; and its environment on top of yours. */
const prepared = ({ argv, env, requires }: Shell) => {
  for (const r of requires) subprocess.requireBinary(r.binary, r.binary, r.install);
  return { argv, env: { ...process.env, ...env } };
};

/** `name`, whose shell `reach` asks the router for afresh each time: what it connects to can change between calls. */
export const reachable = (name: string, reach: (command: string[], tty: boolean) => Promise<Shell>): Reachable => ({
  name,
  async open(command) {
    const { argv, env } = prepared(await reach(command, true));
    return Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  },
  async run(command) {
    const { argv, env } = prepared(await reach(command, false));
    return subprocess.output(argv, { env }, `${command.join(" ")} failed in ${name}`);
  },
});

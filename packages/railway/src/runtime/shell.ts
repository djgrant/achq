import type { ContainerShell } from "@achq/core";

const sshArgs = (location: Record<string, string>, command: string[]) => [
  "ssh",
  "--project",
  location.project!,
  "--environment",
  location.environment!,
  "--service",
  location.service!,
  ...(command.length ? ["--", ...command] : []),
];

const needRailway = () => {
  if (!Bun.which("railway")) throw new Error("Needs the Railway CLI: brew install railway");
};

/** A container through `railway ssh`. */
export const railwayShell: ContainerShell & { sshArgs: typeof sshArgs } = {
  sshArgs,

  reachable: (location) => Boolean(location.project && location.environment && location.service),

  async open(location, command) {
    needRailway();
    return Bun.spawn(["railway", ...sshArgs(location, command)], { stdio: ["inherit", "inherit", "inherit"] }).exited;
  },

  async run(location, command) {
    needRailway();
    const proc = Bun.spawn(["railway", ...sshArgs(location, command)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${command.join(" ")} failed in ${location.service}: ${err.trim() || out.trim()}`);
    return out;
  },
};

import type { Located } from "./containers.ts";

export const sshArgs = (c: Located, command: string[]) => [
  "ssh",
  "--project",
  c.project,
  "--environment",
  c.environment,
  "--service",
  c.service,
  ...(command.length ? ["--", ...command] : []),
];

const needRailway = () => {
  if (!Bun.which("railway")) throw new Error("Needs the Railway CLI: brew install railway");
};

/** `railway ssh` into the container, interactively or running `command`. Returns the exit code. */
export const railwaySsh = async (c: Located, command: string[]) => {
  needRailway();
  const proc = Bun.spawn(["railway", ...sshArgs(c, command)], { stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
};

/** Runs `command` in the container and returns its stdout. */
export const railwayRun = async (c: Located, command: string[]) => {
  needRailway();
  const proc = Bun.spawn(["railway", ...sshArgs(c, command)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed in ${c.service}: ${err.trim() || out.trim()}`);
  return out;
};

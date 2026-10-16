import * as fs from "node:fs";
import * as path from "node:path";
import type { Paths } from "./config.ts";
import { readState } from "./state.ts";

const BUSY = 75;

/**
 * Opens an issue's current session interactively in its worktree, holding the
 * issue's lock so the agent's next run waits until you exit. Fails if a run is
 * in progress.
 */
export const resume = async (paths: Paths, issue: number) => {
  const { session } = readState(paths.state(issue));
  if (!session) throw new Error(`Issue #${issue} has no session`);
  skipOnboarding(paths.home, paths.worktree(issue));
  fs.mkdirSync(path.dirname(paths.lock(issue)), { recursive: true });
  // The shell takes the lock on an fd and execs claude, so claude holds the lock
  // itself and killing it frees the lock (flock's command form would fork).
  const proc = Bun.spawn(
    ["sh", "-c", `exec 9>"$0"; flock --nonblock 9 || exit ${BUSY}; exec claude --resume "$1"`, paths.lock(issue), session],
    {
      cwd: paths.worktree(issue),
      env: { ...process.env, GH_CONFIG_DIR: `${paths.github}/gh`, DISABLE_AUTOUPDATER: "1" },
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  // A dropped SSH connection doesn't always reach claude, which would then hold
  // the lock forever. Stop it when our parent (the SSH shell) goes away.
  const parent = process.ppid;
  const orphaned = setInterval(() => process.ppid !== parent && proc.kill("SIGHUP"), 1000);
  // Railway sleeps the service after minutes without outbound traffic, which an idle session doesn't make.
  const awake = setInterval(() => fetch("https://api.github.com/zen").catch(() => {}), 3 * 60_000);
  for (const signal of ["SIGHUP", "SIGTERM"] as const) process.on(signal, () => proc.kill(signal));
  const code = await proc.exited;
  clearInterval(orphaned);
  clearInterval(awake);
  if (code === BUSY) throw new Error(`The agent is working on issue #${issue}. Try again when its run finishes.`);
  return code;
};

/** Claude's first interactive start asks for a theme and whether to trust the folder. */
const skipOnboarding = (home: string, cwd: string) => {
  const file = path.join(home, ".claude.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  config.hasCompletedOnboarding = true;
  config.theme ??= "dark";
  config.projects ??= {};
  config.projects[cwd] = { ...config.projects[cwd], hasTrustDialogAccepted: true };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
};

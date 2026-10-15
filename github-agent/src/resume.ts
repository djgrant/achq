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
  const code = await Bun.spawn(
    ["flock", "--nonblock", `--conflict-exit-code=${BUSY}`, paths.lock(issue), "claude", "--resume", session],
    {
      cwd: paths.worktree(issue),
      env: { ...process.env, GH_CONFIG_DIR: `${paths.github}/gh`, DISABLE_AUTOUPDATER: "1" },
      stdio: ["inherit", "inherit", "inherit"],
    },
  ).exited;
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

import { run } from "../process.ts";

type Env = Record<string, string | undefined>;

/** `GH_TOKEN` in `env` wins, as it does for gh itself; otherwise `gh auth token`. */
export const ghToken = (env: Env = {}): string => {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  const { ok, stdout, stderr } = run(["gh", "auth", "token"]);
  if (!ok) throw new Error(`Needs a gh login (gh auth login): ${stderr.trim()}`);
  return stdout.trim();
};

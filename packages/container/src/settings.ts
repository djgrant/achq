import { ENV } from "@achq/core";
import { DEFAULT_DATA_DIR } from "./constants.ts";

export type Env = Record<string, string | undefined>;

export const requiredIn = (env: Env, name: string) => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

/** The settings every command needs, from the container's environment (what the deployer's `ContainerSpec.env` sets). */
export const settings = (env: Env) => {
  const repo = requiredIn(env, ENV.repo);
  return {
    repo,
    container: requiredIn(env, ENV.container),
    dataDir: env.DATA_DIR ?? env.RAILWAY_VOLUME_MOUNT_PATH ?? DEFAULT_DATA_DIR,
    repoUrl: env.ACHQ_REPO_URL ?? `https://github.com/${repo}.git`,
    bin: { claude: env.ACHQ_CLAUDE_BIN ?? "claude" },
  };
};

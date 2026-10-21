import { ENV } from "@achq/core";
import { collections } from "@achq/utils/collections";
import { disk } from "@achq/utils/disk";
import type { Vars } from "@achq/utils/env";
import { text } from "@achq/utils/text";

/**
 * Never handed to an agent. The container secret proves the container's
 * identity to the router, so an agent holding it could mint every credential
 * the container has and post as the channel. The key only exists on the router
 * and deployer. Every implementation's own private variables are listed
 * in ENV.privateEnv, which the deployer sets.
 */
export const PRIVATE_ENV = [ENV.containerSecret, ENV.key, ENV.privateEnv];

/** Only the agent's user reads its credentials. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const GIT_IDENTITY_PREFIXES = ["GIT_AUTHOR_", "GIT_COMMITTER_"];

export const withoutPrivate = (env: Vars) => {
  const hidden = new Set([...PRIVATE_ENV, ...text.commaList(env[ENV.privateEnv] ?? "")]);
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !hidden.has(name))) as Record<string, string>;
};

export const agentEnv = (base: Vars, home: string, credentialEnv: Record<string, string>, { name, email }: { name: string; email: string }) => ({
  ...withoutPrivate(base),
  HOME: home,
  ...credentialEnv,
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: email,
});

/** For `resume`, which opens sessions outside the runner: the credentials and git identity the last run had. */
export const saveAgentEnv = (file: string, credentialEnv: Record<string, string>, env: Record<string, string>) => {
  const identity = collections.filterKeys(env, (name) => GIT_IDENTITY_PREFIXES.some((prefix) => name.startsWith(prefix)));
  disk.writeEnsured(file, JSON.stringify({ ...credentialEnv, ...identity }), { mode: PRIVATE_FILE_MODE, dirMode: PRIVATE_DIR_MODE });
};

export const savedAgentEnv = (file: string) => disk.readJsonSync<Record<string, string>>(file) ?? {};

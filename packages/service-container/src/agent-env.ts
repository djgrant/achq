import { filterKeys } from "@achq/utils/collections";
import { readJsonSync, writeFileEnsured } from "@achq/utils/fs";
import { withoutPrivate } from "./env.ts";

type Identity = { name: string; email: string };

/** Only the agent's user reads its credentials. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const GIT_IDENTITY_PREFIXES = ["GIT_AUTHOR_", "GIT_COMMITTER_"];

export const gitIdentity = ({ name, email }: Identity): Record<string, string> => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: email,
});

export const gitIdentityEnv = (env: Record<string, string>) => filterKeys(env, (k) => GIT_IDENTITY_PREFIXES.some((prefix) => k.startsWith(prefix)));

export const agentEnv = (base: Record<string, string | undefined>, home: string, credentialEnv: Record<string, string>, identity: Identity): Record<string, string> => ({
  ...withoutPrivate(base),
  HOME: home,
  ...credentialEnv,
  ...gitIdentity(identity),
});

/** For `resume`, which opens sessions outside the runner: the credentials and git identity the last run had. */
export const saveAgentEnv = (file: string, credentialEnv: Record<string, string>, env: Record<string, string>) => {
  const saved = { ...credentialEnv, ...gitIdentityEnv(env) };
  writeFileEnsured(file, JSON.stringify(saved), { mode: PRIVATE_FILE_MODE, dirMode: PRIVATE_DIR_MODE });
};

export const savedAgentEnv = (file: string): Record<string, string> => readJsonSync(file, {});

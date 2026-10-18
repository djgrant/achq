import * as fs from "node:fs";
import * as path from "node:path";
import { withoutPrivate } from "./env.ts";

/** What an agent runs with: the container's env without private variables, HOME, its credentials, and the channel's identity for commits. */
export const agentEnv = (
  base: Record<string, string | undefined>,
  home: string,
  credentialEnv: Record<string, string>,
  identity: { name: string; email: string },
): Record<string, string> => ({
  ...withoutPrivate(base),
  HOME: home,
  ...credentialEnv,
  GIT_AUTHOR_NAME: identity.name,
  GIT_AUTHOR_EMAIL: identity.email,
  GIT_COMMITTER_NAME: identity.name,
  GIT_COMMITTER_EMAIL: identity.email,
});

/** For `resume`, which opens sessions outside the runner: the credentials and git identity the last run had. */
export const saveAgentEnv = (file: string, credentialEnv: Record<string, string>, env: Record<string, string>) => {
  const saved = { ...credentialEnv, ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("GIT_AUTHOR_") || k.startsWith("GIT_COMMITTER_"))) };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
};

export const savedAgentEnv = (file: string): Record<string, string> => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});

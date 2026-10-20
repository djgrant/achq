import { ghToken } from "@achq/utils/gh";
import { github } from "./client.ts";

type Env = Record<string, string | undefined>;

/** The API as you. `GH_TOKEN` in `env` skips gh (tests set it); the token is only asked for on the first request. */
export const userGitHub = (api: string, env: Env = {}) => {
  let token: string | undefined;
  return github(() => `token ${(token ??= ghToken(env))}`, api);
};

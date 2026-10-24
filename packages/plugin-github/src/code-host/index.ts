import type { CodeHostImplementation } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { CODE_HOST, PRIVATE_ENV } from "../lib/constants.ts";
import { GitHubCodeHostAsYou, GitHubCodeHostProvider } from "./provider.ts";

/** The services' side has the App keys that list installed repos; the CLI's is you, through your gh login. */
export const githubCodeHostProvider: CodeHostImplementation = {
  id: CODE_HOST,
  create: (env) => new GitHubCodeHostProvider(env, appsFor(env)),
  asYou: (env) => new GitHubCodeHostAsYou(env),
  privateEnv: PRIVATE_ENV,
};

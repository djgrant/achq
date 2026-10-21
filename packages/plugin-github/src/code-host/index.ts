import type { CodeHostProvider, Implementation } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { CODE_HOST, PRIVATE_ENV } from "../lib/constants.ts";
import { GitHubCodeHostProvider } from "./provider.ts";

/** The router's instance has the App keys that list installed repos. */
export const githubCodeHostProvider: Implementation<CodeHostProvider> = {
  id: CODE_HOST,
  create: (env) => new GitHubCodeHostProvider(env, appsFor(env)),
  privateEnv: PRIVATE_ENV,
};

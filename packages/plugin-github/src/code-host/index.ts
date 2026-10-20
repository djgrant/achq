import type { Implementation, CodeHostProvider } from "@achq/core";
import { PRIVATE_ENV, CODE_HOST } from "../lib/constants.ts";
import { appsFor } from "../lib/apps.ts";
import { githubUrls } from "../lib/client.ts";
import { GitHubCodeHostProvider } from "./provider.ts";

/** The router's instance has the App keys that list installed repos. */
export const githubCodeHostProvider: Implementation<CodeHostProvider> = {
  id: CODE_HOST,
  create: (env) => new GitHubCodeHostProvider(githubUrls(env), appsFor(env)),
  privateEnv: PRIVATE_ENV,
};

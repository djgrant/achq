import type { Implementation, CodeHostProvider } from "@achq/core";
import { PRIVATE_ENV, CODE_HOST } from "../lib/constants.ts";
import { githubUrls } from "../lib/client.ts";
import { GitHubCodeHostProvider } from "./provider.ts";

/** Repos on GitHub (or the fake the env points at). */
export const githubCodeHostProvider: Implementation<CodeHostProvider> = {
  id: CODE_HOST,
  create: (env) => new GitHubCodeHostProvider(githubUrls(env)),
  privateEnv: PRIVATE_ENV,
};

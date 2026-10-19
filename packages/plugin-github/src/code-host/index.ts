import type { Implementation, CodeHost } from "@achq/core";
import { PRIVATE_ENV, CODE_HOST } from "../lib/constants.ts";
import { githubUrls } from "../lib/client.ts";
import { GitHubCodeHost } from "./runtime.ts";

/** Repos on GitHub (or the fake the env points at). */
export const githubCodeHost: Implementation<CodeHost> = {
  id: CODE_HOST,
  create: (env) => new GitHubCodeHost(githubUrls(env)),
  privateEnv: PRIVATE_ENV,
};

import type { Implementation, RepoHost } from "@achq/core";
import { PRIVATE_ENV, PROVIDER } from "../lib/constants.ts";
import { githubUrls } from "../lib/urls.ts";
import { githubRepos } from "./repos.ts";

/** Repos on GitHub (or the fake the env points at). */
export const githubRepoHost: Implementation<RepoHost> = {
  id: PROVIDER,
  create: (env) => githubRepos(githubUrls(env)),
  privateEnv: PRIVATE_ENV,
};

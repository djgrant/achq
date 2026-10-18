import type { Provider } from "@achq/core";
import { GITHUB_API, GITHUB_ENV, GITHUB_WEB, PRIVATE_ENV, PROVIDER } from "./constants.ts";
import { githubCli } from "./cli/cli.ts";
import { githubInfra } from "./cli/infra.ts";
import { parseApps } from "./runtime/app-keys.ts";
import { createGitHub } from "./runtime/github.ts";
import { githubRepos } from "./runtime/repos.ts";

type Env = Record<string, string | undefined>;

const urls = (env: Env) => ({ api: env[GITHUB_ENV.api] || GITHUB_API, web: env[GITHUB_ENV.web] || GITHUB_WEB });

/** GitHub: Apps as channels and access providers, and the repos they're installed on. */
export const githubProvider: Provider = {
  id: PROVIDER,
  policySource: (policy) => (typeof policy.app === "string" ? policy.app : undefined),
  router(env, key) {
    const github = createGitHub({ apps: parseApps(env[GITHUB_ENV.apps]), key, baseUrl: urls(env).api });
    return { channel: github.channel, access: github.access, installations: github.installations, sources: github.sources };
  },
  container(env) {
    const { channel, access } = createGitHub({ baseUrl: urls(env).api });
    return { channel, access };
  },
  repos: (env) => githubRepos(urls(env)),
  infra: (env) => githubInfra(urls(env)),
  cli: (env) => githubCli(urls(env)),
  privateEnv: PRIVATE_ENV,
};

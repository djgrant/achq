import { GITHUB_API, GITHUB_ENV, GITHUB_WEB } from "./constants.ts";

type Env = Record<string, string | undefined>;

export type GitHubUrls = { api: string; web: string };

export const githubUrls = (env: Env): GitHubUrls => ({ api: env[GITHUB_ENV.api] || GITHUB_API, web: env[GITHUB_ENV.web] || GITHUB_WEB });

export const botLogin = (slug: string) => `${slug}[bot]`;

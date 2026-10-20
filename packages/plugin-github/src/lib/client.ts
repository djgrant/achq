// Where GitHub's API and website are for achq, and who an App is on them. The
// client itself is @achq/utils/gh.
import { type Auth, GitHub } from "@achq/utils/gh";
import { GITHUB_API, GITHUB_ENV, GITHUB_WEB } from "./constants.ts";

type Env = Record<string, string | undefined>;

export type GitHubUrls = { api: string; web: string };

/** The API and the website, unless the env points them at a fake. */
export const githubUrls = (env: Env): GitHubUrls => ({ api: env[GITHUB_ENV.api] || GITHUB_API, web: env[GITHUB_ENV.web] || GITHUB_WEB });

/** The bot user an App comments as. */
export const botLogin = (slug: string) => `${slug}[bot]`;

/** The API as an installation or user token. */
export const asToken = (token: string, api: string) => GitHub.connect(`token ${token}`, { baseUrl: api });

/** The API as whatever `auth` gives. */
export const github = (auth: Auth, api: string) => GitHub.connect(auth, { baseUrl: api });

import type { Vars } from "@achq/utils/env";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";

export const CHANNEL = "github";
export const POLICY_PROVIDER = "github";
export const CODE_HOST = "github";

/** The repository variable the deployer reports each deploy's outcome in, as a `Status`. */
export const STATUS_VARIABLE = "ACHQ_STATUS";

/** GitHub's rules for owner and repository names. */
export const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const GITHUB_ENV = {
  /** Router only: `achq infra up` sets it. */
  apps: "ACHQ_GITHUB_APPS",
  /** Points the API client at a fake. */
  api: "GITHUB_API_URL",
  /** Points web links and clone URLs at a fake. */
  web: "GITHUB_WEB_URL",
} as const;

export type GitHubUrls = { api: string; web: string };

/** Where `env` points the API client, and web links and clone URLs. */
export const githubUrls = (env: Vars) => ({ api: env[GITHUB_ENV.api] || GITHUB_API, web: env[GITHUB_ENV.web] || GITHUB_WEB });

/** Where you install an App: on an owner that has it already, GitHub goes on to its installation, where you add the repo. */
export const appInstallPage = ({ web }: GitHubUrls, slug: string) => `${web}/apps/${slug}/installations/new`;

/** Variables that only exist on the router, or that an App's own tooling sets. */
export const PRIVATE_ENV = [GITHUB_ENV.apps, "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID"];

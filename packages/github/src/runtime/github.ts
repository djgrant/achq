import { GITHUB_API } from "../constants.ts";
import { GitHubAccess } from "./access.ts";
import type { AppKeys } from "./app-keys.ts";
import { Apps } from "./apps.ts";
import { GitHubChannel } from "./channel.ts";
import { installations, sources } from "./installations.ts";

export type GitHubOptions = {
  /** Router only: `{ [slug]: { id, privateKey } }`, from ENV.githubApps. */
  apps?: AppKeys;
  /** Router only: AGENT_WEBHOOK_KEY, which each App's webhook secret derives from. */
  key?: string;
  /** For tests: a fake GitHub API. */
  baseUrl?: string;
};

/**
 * The router passes `apps` and `key`. The container passes neither, and only
 * uses `channel.client`, `channel.match*` and `access.install`.
 */
export const createGitHub = (options: GitHubOptions = {}) => {
  const apps = new Apps(options.apps ?? {}, options.baseUrl ?? GITHUB_API);
  return {
    channel: new GitHubChannel(apps, options.key),
    access: new GitHubAccess(apps),
    installations: () => installations(apps),
    sources: () => sources(apps),
  };
};

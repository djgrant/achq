import type { Implementation, InstallationProvider } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { CHANNEL, PRIVATE_ENV } from "../lib/constants.ts";
import { GitHubInstallationProvider } from "./provider.ts";

/** Apps installed on repos. The CLI's instance installs them as you; the router's has the App keys that list them. */
export const githubInstallationProvider: Implementation<InstallationProvider> = {
  id: CHANNEL,
  create: (env) => new GitHubInstallationProvider(appsFor(env)),
  privateEnv: PRIVATE_ENV,
};

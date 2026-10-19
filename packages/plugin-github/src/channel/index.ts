import { type ChannelProvider, ENV, type Implementation } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { CHANNEL, PRIVATE_ENV } from "../lib/constants.ts";
import { GitHubChannelProvider } from "./provider.ts";

/** GitHub issues, through Apps. The router's instance has the App keys and AGENT_WEBHOOK_KEY; a container's has neither. */
export const githubChannelProvider: Implementation<ChannelProvider> = {
  id: CHANNEL,
  create: (env) => new GitHubChannelProvider(appsFor(env), env[ENV.key]),
  privateEnv: PRIVATE_ENV,
};

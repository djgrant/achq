import { type Channel, ENV, type Implementation } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { CHANNEL, PRIVATE_ENV } from "../lib/constants.ts";
import { GitHubChannel } from "./runtime.ts";

/** GitHub issues, through Apps. The router's instance has the App keys and AGENT_WEBHOOK_KEY; a container's has neither. */
export const githubChannel: Implementation<Channel> = {
  id: CHANNEL,
  create: (env) => new GitHubChannel(appsFor(env), env[ENV.key]),
  privateEnv: PRIVATE_ENV,
};

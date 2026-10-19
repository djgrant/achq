import type { Channel, Implementation } from "@achq/core";
import { appsFor } from "../lib/apps.ts";
import { PRIVATE_ENV } from "../lib/constants.ts";
import { githubUrls } from "../lib/urls.ts";
import { GitHubChannel } from "./channel.ts";
import { CHANNEL } from "./constants.ts";

/** GitHub issues, through Apps. The router's instance has the App keys and AGENT_WEBHOOK_KEY; a container's has neither. */
export const githubChannel: Implementation<Channel> = {
  id: CHANNEL,
  create: (env, key) => new GitHubChannel(appsFor(env), key, githubUrls(env)),
  privateEnv: PRIVATE_ENV,
};

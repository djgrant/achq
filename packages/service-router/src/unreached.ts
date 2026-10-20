// What the router says on a thread when no container answered its delivery,
// so whoever asked isn't left waiting.
import { type ChannelEvent, threadKey } from "@achq/core";
import { errorMessage } from "@achq/utils/errors";
import type { RouterContext } from "./context.ts";
import type { Target } from "./targets.ts";

export const unreachedReply = (containers: string[]) =>
  `⚠️ This didn't reach the agent: ${containers.map((c) => `\`${c}\``).join(" and ")} didn't answer. It's kept, and runs when someone replays it with \`achq replay\`.`;

/** Replies on the event's thread, as its channel's source, naming the containers among `failed`. Whether it did: a failure to is only logged. */
export const tellUnreached = async (ctx: RouterContext, event: ChannelEvent, failed: Target[]) => {
  const containers = failed.flatMap((t) => (t.kind === "container" ? [t.container] : []));
  const channel = ctx.channelProviders.find((c) => c.id === event.channel);
  if (!containers.length || !channel || !event.thread || !event.repo) return false;
  try {
    const client = channel.client(await channel.mintClient(event.source, event.repo));
    await client.reply(event.thread, unreachedReply(containers));
    return true;
  } catch (e) {
    ctx.log(`${event.delivery}: couldn't tell ${threadKey(event.thread)} it failed: ${errorMessage(e)}`);
    return false;
  }
};

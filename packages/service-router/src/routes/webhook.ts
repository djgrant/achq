import type { ChannelProvider } from "@achq/core";
import { isSafeFileName } from "@achq/utils/fs";
import { textResponse } from "@achq/utils/http";
import { claimsOf, configOf, type RouterContext } from "../context.ts";
import { acceptDelivery } from "../inbox.ts";
import { targetsFor } from "../targets.ts";

const verifiedChannel = async (ctx: RouterContext, headers: Headers, body: string): Promise<{ channel: ChannelProvider; source: string } | undefined> => {
  for (const channel of ctx.channelProviders) {
    const source = await channel.verify(headers, body);
    if (source) return { channel, source };
  }
};

export const webhook = async (ctx: RouterContext, req: Request) => {
  const body = await req.text();
  const found = await verifiedChannel(ctx, req.headers, body);
  if (!found) return textResponse("bad signature", 401);
  const event = found.channel.parse(found.source, req.headers, body);
  if (!event) return textResponse("ignored");
  // The delivery ID names its inbox file.
  if (!isSafeFileName(event.delivery)) return textResponse("bad delivery id", 400);

  const targets = targetsFor(found.channel, event, configOf(ctx, event.repo), claimsOf(ctx, event.repo));
  if (!targets.length) return textResponse("no match");
  // Persisted before answering, so a crash or restart doesn't lose it. Answered
  // without waiting for the targets: the channel gives up after seconds, and a
  // waking service takes longer.
  const accepted = await acceptDelivery(ctx, { event, targets });
  return textResponse(accepted ? "accepted" : "duplicate", 202);
};

import type { ChannelProvider } from "@achq/core";
import { disk } from "@achq/utils/disk";
import { Hono } from "hono";
import { claimsOf, configOf, type RouterContext } from "../context.ts";
import { acceptDelivery } from "../inbox.ts";
import { targetsFor } from "../targets.ts";

const verifiedChannel = async (ctx: RouterContext, headers: Headers, body: string): Promise<{ channel: ChannelProvider; source: string } | undefined> => {
  for (const channel of ctx.channelProviders) {
    const source = await channel.verify(headers, body);
    if (source) return { channel, source };
  }
};

/** Deliveries from channels, each checked against its channel's own signature. */
export const webhook = (ctx: RouterContext) =>
  new Hono().post("/webhook", async (c) => {
    const body = await c.req.text();
    const headers = c.req.raw.headers;
    const found = await verifiedChannel(ctx, headers, body);
    if (!found) return c.text("bad signature", 401);
    const event = found.channel.parse(found.source, headers, body);
    if (!event) return c.text("ignored");
    // The delivery ID names its inbox file.
    if (!disk.isSafeFileName(event.delivery)) return c.text("bad delivery id", 400);

    const targets = targetsFor(found.channel, event, configOf(ctx, event.repo), claimsOf(ctx, event.repo));
    if (!targets.length) return c.text("no match");
    // Persisted before answering, so a crash or restart doesn't lose it. Answered
    // without waiting for the targets: the channel gives up after seconds, and a
    // waking service takes longer.
    const accepted = await acceptDelivery(ctx, { event, targets });
    return c.text(accepted ? "accepted" : "duplicate", 202);
  });

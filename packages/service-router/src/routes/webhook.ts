import type { RouterContext } from "../context.ts";
import { configOf } from "../context.ts";
import { text } from "../http.ts";
import { type InboxEntry, track } from "../inbox.ts";
import { safeName } from "../store.ts";
import { targetsFor } from "../targets.ts";

const verified = async (ctx: RouterContext, headers: Headers, body: string) => {
  for (const channel of ctx.channelProviders) {
    const source = await channel.verify(headers, body);
    if (source) return { channel, source };
  }
};

export const webhook = async (ctx: RouterContext, req: Request) => {
  const body = await req.text();
  const found = await verified(ctx, req.headers, body);
  if (!found) return text("bad signature", 401);
  const event = found.channel.parse(found.source, req.headers, body);
  if (!event) return text("ignored");
  if (!safeName(event.delivery)) return text("bad delivery id", 400);

  const config = configOf(ctx, event.repo);
  const targets = targetsFor(found.channel, event, config, ctx.claims.get(event.repo?.toLowerCase() ?? "") ?? {});
  if (!targets.length) return text("no match");
  if (ctx.inFlight.has(event.delivery)) return text("duplicate", 202);

  // Persisted before answering, so a crash or restart doesn't lose it.
  const entry: InboxEntry = { event, targets };
  ctx.inFlight.set(event.delivery, Promise.resolve());
  try {
    await ctx.store.write("inbox", event.delivery, entry);
  } catch (e) {
    ctx.inFlight.delete(event.delivery);
    throw e;
  }
  // Answer now: the channel gives up after seconds, and a waking service takes longer.
  track(ctx, entry);
  return text("accepted", 202);
};

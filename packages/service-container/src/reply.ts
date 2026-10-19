import type { ChannelClient, ThreadRef } from "@achq/core";

/** Posts on the thread. A reply that fails is logged, not thrown: there's nowhere else to report it. */
export const reply = async (client: ChannelClient, ref: ThreadRef, body: string, log: (line: string) => void) => {
  await client.reply(ref, body).catch((e) => log(`reply failed: ${e}`));
};

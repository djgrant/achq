import type { ChannelClient, ThreadRef } from "@achq/core";
import { logFailure } from "./log-failure.ts";

/** Posts on the thread. A reply that fails is logged, not thrown: there's nowhere else to report it. */
export const reply = (client: ChannelClient, ref: ThreadRef, body: string, log: (line: string) => void) => logFailure(client.reply(ref, body), log, "reply failed");

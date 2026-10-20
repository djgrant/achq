import { type ChannelProvider, type ChannelClient, threadKey } from "@achq/core";
import { logFailure } from "./log-failure.ts";
import { runInterrupted } from "./messages.ts";
import { allStates, type ThreadState, writeState } from "./state.ts";

export type InterruptedOptions = {
  threads: string;
  channelProviders: ChannelProvider[];
  client: (channel: ChannelProvider, source: string) => Promise<ChannelClient>;
  log: (line: string) => void;
};

export const reportInterrupted = async (opts: InterruptedOptions) => {
  for (const { file, state } of allStates(opts.threads)) {
    const interrupted = markInterrupted(state);
    if (!interrupted.length) continue;
    writeState(file, state);
    const label = `[${threadKey(state.thread)}] couldn't report the interrupted run`;
    await logFailure(tellThread(opts, state, interrupted), opts.log, label);
  }
};

const markInterrupted = (state: ThreadState): string[] =>
  Object.entries(state.sessions)
    .filter(([, s]) => s.status === "running")
    .map(([agent, s]) => {
      s.status = "interrupted";
      return `${agent} \`${s.id}\``;
    });

const tellThread = async (opts: InterruptedOptions, state: ThreadState, sessions: string[]) => {
  const channel = opts.channelProviders.find((c) => c.id === state.thread.channel);
  if (!channel) return;
  const client = await opts.client(channel, state.source);
  await client.reply(state.thread, runInterrupted(sessions.join(", ")));
};

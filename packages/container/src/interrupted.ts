import { type Channel, type ChannelClient, threadKey } from "@achq/core";
import { allStates, writeState } from "./state.ts";

/** Marks runs a restart interrupted and says so on their threads. */
export const reportInterrupted = async (opts: {
  threads: string;
  channels: Channel[];
  client: (channel: Channel, source: string) => Promise<ChannelClient>;
  log: (line: string) => void;
}) => {
  for (const { file, state } of allStates(opts.threads)) {
    const interrupted = Object.entries(state.sessions).filter(([, s]) => s.status === "running");
    if (!interrupted.length) continue;
    for (const [, s] of interrupted) s.status = "interrupted";
    writeState(file, state);
    const channel = opts.channels.find((c) => c.id === state.thread.channel);
    if (!channel) continue;
    const list = interrupted.map(([agent, s]) => `${agent} \`${s.id}\``).join(", ");
    try {
      const client = await opts.client(channel, state.source);
      await client.reply(
        state.thread,
        `⚠️ The agent restarted while a run was in progress. The work so far is in the worktree and the session is intact; the next message resumes it.\n\n<sub>${list}</sub>\n`,
      );
    } catch (e) {
      opts.log(`[${threadKey(state.thread)}] couldn't report the interrupted run: ${e}`);
    }
  }
};

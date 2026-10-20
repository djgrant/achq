/** Context and usage figures gathered from Claude's stream-json output. */
export class StreamStats {
  session?: string;
  context?: number;
  window?: number;
  turns?: number;
  compacted?: { pre: number; post: number };
  result?: { is_error: boolean; subtype: string; result?: string; errors?: string[] };

  push(event: any) {
    if (event.session_id) this.session = event.session_id;
    if (event.type === "assistant" && !event.parent_tool_use_id && event.message?.usage) {
      const u = event.message.usage;
      this.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    } else if (event.type === "system" && event.subtype === "compact_boundary") {
      const { pre_tokens, post_tokens } = event.compact_metadata;
      this.context = post_tokens;
      this.compacted = { pre: pre_tokens, post: post_tokens };
    } else if (event.type === "result") {
      this.result = event;
      this.turns = event.num_turns;
      const windows = Object.values(event.modelUsage ?? {}).map((m: any) => m.contextWindow ?? 0);
      if (windows.length) this.window = Math.max(...windows);
    }
  }
}

/** A token count to read at a glance: `1.2M`, `45k`, `900`. */
export const tokens = (n: number): string => {
  if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}k`;
  return `${n}`;
};

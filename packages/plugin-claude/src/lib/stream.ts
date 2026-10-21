import type { Collected } from "@achq/utils/subprocess";

const COMPACT_COMMAND = "/compact";
const TOOL_INPUT_LOG_CHARS = 200;
const TEXT_LOG_CHARS = 500;
const NO_REPLY = "Claude finished without a reply.";
const TIMED_OUT = "The run timed out and was stopped.";

/** A token count to read at a glance: `1.2M`, `45k`, `900`. */
const tokens = (n: number) => {
  if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}k`;
  return `${n}`;
};

/** What a run's stream-json output says: its result, and what a compaction did. */
export class ClaudeStream {
  private compacted?: { pre: number; post: number };
  private result?: { is_error: boolean; subtype: string; result?: string; errors?: string[] };

  /** Takes a line of output, logging what the agent does. A line that isn't JSON is logged as it is. */
  read(line: string, log: (line: string) => void) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return log(line);
    }
    if (event.type === "system" && event.subtype === "compact_boundary") this.compacted = { pre: event.compact_metadata.pre_tokens, post: event.compact_metadata.post_tokens };
    if (event.type === "result") this.result = event;
    if (event.type !== "assistant") return;
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use") log(`→ ${block.name} ${JSON.stringify(block.input).slice(0, TOOL_INPUT_LOG_CHARS)}`);
      if (block.type === "text") log(String(block.text).slice(0, TEXT_LOG_CHARS));
    }
  }

  /** Why the run failed, or undefined if it didn't: Claude's own error, the timeout, or the exit status. */
  failure(proc: Collected, signal: AbortSignal) {
    if (this.result?.is_error) return `${this.result.subtype}: ${this.result.result ?? this.result.errors?.join("\n") ?? ""}`;
    if (proc.exitCode === 0) return undefined;
    if (signal.aborted) return TIMED_OUT;
    return `claude exited with ${proc.signalCode ?? proc.exitCode}`;
  }

  /** The reply to post: the compaction's effect for `/compact`, otherwise Claude's result. */
  reply(prompt: string) {
    if (this.compacted && prompt.startsWith(COMPACT_COMMAND)) return `Compacted the session: ${tokens(this.compacted.pre)} → ${tokens(this.compacted.post)} tokens.`;
    return this.result?.result?.trim() || NO_REPLY;
  }
}

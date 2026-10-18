export type Mode = "resume" | "new" | "compact";
export type Command = { mode: Mode; text: string };

/**
 * The command in a comment is whatever follows the first trigger:
 *   @claude <prompt>          resume the issue's session (or start one)
 *   @claude /new <prompt>     start a fresh session
 *   @claude /compact [focus]  compact the issue's session
 */
export const parseCommand = (body: string, trigger: string): Command => {
  const at = body.indexOf(trigger);
  let text = (at < 0 ? body : body.slice(at + trigger.length)).trimStart();
  let mode: Mode = "resume";
  for (const m of ["new", "compact"] as const) {
    if (new RegExp(`^/${m}(?![\\w-])`).test(text)) {
      mode = m;
      text = text.slice(m.length + 1).trimStart();
      break;
    }
  }
  return { mode, text: text.trimEnd() };
};

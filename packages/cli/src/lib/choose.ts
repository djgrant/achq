// Choosing one of several things a command acts on, e.g. a container or a
// session: the one already picked, or one you choose at the terminal. Without
// a terminal, the caller says what happens instead.
import type { Prompter } from "@pokit/core";
import { interactive } from "./terminal.ts";

export type ChooseOptions<T, F> = {
  /** The prompt, e.g. `Container`. */
  message: string;
  /** Tells the items apart in the prompt. */
  id: (item: T) => string;
  label: (item: T) => string;
  hint?: (item: T) => string;
  /** What happens with no terminal to choose at: throw, or a stand-in for the caller to handle. */
  withoutTerminal: () => F;
};

export const chooseOne = async <T, F>(prompter: Prompter, items: T[], picked: T | undefined, options: ChooseOptions<T, F>): Promise<T | F> => {
  if (picked) return picked;
  if (!interactive()) return options.withoutTerminal();
  const { message, id, label, hint } = options;
  const chosen = await prompter.select({ message, options: items.map((item) => ({ value: id(item), label: label(item), hint: hint?.(item) })) });
  return items.find((item) => id(item) === chosen)!;
};

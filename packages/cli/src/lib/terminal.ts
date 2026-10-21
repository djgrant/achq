import { markOperational, type Prompter } from "@pokit/core";
import { CLI_ENV, TERMINAL_ENV } from "../constants.ts";

const BUGS = [TypeError, ReferenceError, SyntaxError, RangeError];

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

export const chooseOne = async <T, F>(prompter: Prompter, items: T[], picked: T | undefined, options: ChooseOptions<T, F>) => {
  if (picked) return picked;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return options.withoutTerminal();
  const { message, id, label, hint } = options;
  const chosen = await prompter.select({ message, options: items.map((item) => ({ value: id(item), label: label(item), hint: hint?.(item) })) });
  return items.find((item) => id(item) === chosen)!;
};

/** A container's shell may set only TERM=xterm; pass your terminal's on, so programs in it know its keys. */
export const terminalEnv = () => TERMINAL_ENV.flatMap((name) => (process.env[name] ? [`${name}=${process.env[name]}`] : []));

/**
 * Wraps a command's `run` so failures print as a message, without a stack.
 * Errors that look like bugs keep theirs, and so does everything with ACHQ_DEBUG set.
 */
export const clean =
  <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      return await run(...args);
    } catch (error) {
      if (error instanceof Error && !process.env[CLI_ENV.debug] && !BUGS.some((type) => error instanceof type)) markOperational(error);
      throw error;
    }
  };

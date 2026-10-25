import { markOperational, type Prompter } from "@pokit/core";
import { subprocess } from "@achq/utils/subprocess";

const BUGS = [TypeError, ReferenceError, SyntaxError, RangeError];
/** Set to keep stacks on every error. */
const DEBUG = "ACHQ_DEBUG";
/** The terminal's variables, passed on to the container's shell, which may set only TERM=xterm. */
const TERMINAL_ENV = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"];

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
  if (!interactive()) return options.withoutTerminal();
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
      if (error instanceof Error && !process.env[DEBUG] && !BUGS.some((type) => error instanceof type)) markOperational(error);
      throw error;
    }
  };

/** Whether there's someone at a terminal to ask. */
export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Waits for you to press Enter, e.g. once you've done what the browser was opened to. */
export const waitForEnter = async (prompter: Prompter, message: string) => {
  await prompter.select({ message, options: [{ value: true, label: "Done" }] });
};

/** Asks a yes-or-no question, where no is the default. Without a terminal to ask at, it's no. */
export const confirm = async (prompter: Prompter, message: string) => interactive() && (await prompter.confirm({ message, initialValue: false }));

/** Opens the URL in your browser, printing it only when that fails: Cloudflare's are long. */
export const openInBrowser = async (url: string, what: string) => {
  console.log(`  opening your browser to ${what}…`);
  if (!subprocess.openUrl(url)) console.log(`  it didn't open, so go to ${url}`);
};

/**
 * Asks for a secret on the terminal, e.g. a token you just made, showing a `*`
 * for each character. Without a terminal, reads a line from stdin.
 */
export const readSecret = async (prompter: Prompter, message: string): Promise<string> => {
  if (interactive()) return prompter.password({ message });
  process.stdout.write(`  ${message}: `);
  let line = "";
  for await (line of console) break;
  process.stdout.write("\n");
  return line;
};

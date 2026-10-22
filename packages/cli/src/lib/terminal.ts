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

const ENTER = ["\r", "\n"];
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = ["\u007f", "\b"];

/**
 * Asks for a secret on the terminal, e.g. a token you just made, without
 * echoing it. Without a terminal, reads a line from stdin.
 */
export const readSecret = async (message: string): Promise<string> => {
  const stdin = process.stdin;
  process.stdout.write(`  ${message}: `);
  if (!stdin.isTTY) {
    let line = "";
    for await (line of console) break;
    process.stdout.write("\n");
    return line;
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((resolve, reject) => {
      let typed = "";
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (ENTER.includes(char) || char === CTRL_D) {
            stdin.off("data", onData);
            return resolve(typed);
          }
          if (char === CTRL_C) {
            stdin.off("data", onData);
            return reject(new Error("Cancelled"));
          }
          if (BACKSPACE.includes(char)) typed = typed.slice(0, -1);
          else typed += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\n");
  }
};

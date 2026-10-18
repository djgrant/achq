import { markOperational } from "@pokit/core";

const BUGS = [TypeError, ReferenceError, SyntaxError, RangeError];

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
      if (error instanceof Error && !process.env.ACHQ_DEBUG && !BUGS.some((type) => error instanceof type)) markOperational(error);
      throw error;
    }
  };

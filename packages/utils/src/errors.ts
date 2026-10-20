// What a caught value says. Anything can be thrown, so these accept `unknown`
// and never throw themselves.

/** The error's message, or the thrown value as a string: for replies and one-line logs. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The error's stack, which starts with its message, or the thrown value as a string: for logs. */
export const errorDetail = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

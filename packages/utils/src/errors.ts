export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The error's stack, which starts with its message. */
export const errorDetail = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

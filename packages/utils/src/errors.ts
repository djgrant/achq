export const errors = {
  message: (e: unknown): string => (e instanceof Error ? e.message : String(e)),

  /** The error's stack, which starts with its message. */
  detail: (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e)),
};

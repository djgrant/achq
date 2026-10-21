export const errors = {
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),

  /** The error's stack, which starts with its message. */
  detail: (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e)),
};

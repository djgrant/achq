export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

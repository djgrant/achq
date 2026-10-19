/** A payload's labels, as names. */
export const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels) ? labels.map((l) => (typeof l === "string" ? l : l?.name)).filter((n): n is string => typeof n === "string") : [];

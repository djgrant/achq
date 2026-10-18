import type { Changed } from "./diff.ts";

/**
 * A change in a plan, for printing. It names params, never their values.
 * `?` is a node whose params depend on a change that hasn't been applied yet.
 */
export type Change = { op: "+" | "~" | "?"; target: string; detail?: string };

export const formatChange = (c: Change) => `${c.op} ${c.target}${c.detail ? ` ${c.detail}` : ""}`;

/** The changed params, or for a plain object its changed entries. */
export const describeChanged = (changed: Changed[]) => changed.flatMap((c) => c.entries ?? [c.field]).join(", ");

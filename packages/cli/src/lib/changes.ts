import type { Change, Plan } from "@achq/core";

export const formatChange = (c: Change) => `${c.op} ${c.target}${c.detail ? ` ${c.detail}` : ""}`;

/** A plan's changes, then its warnings. */
export const planLines = (planned: Pick<Plan, "changes" | "warnings">) => [...planned.changes.map(formatChange), ...planned.warnings.map((w) => `! ${w}`)];

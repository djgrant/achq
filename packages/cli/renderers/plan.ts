import type { Change, Plan, Teardown } from "@achq/core";
import { text } from "@achq/utils/text";

/** Changes that do the same to the same target as one, where the first was, with their details and names together. */
const collapse = (changes: Change[]) => {
  const rows = new Map<string, { change: Change; details: Set<string>; names: Set<string> }>();
  for (const c of changes) {
    const key = JSON.stringify([c.op, c.target, c.what]);
    const row = rows.get(key) ?? { change: c, details: new Set(), names: new Set() };
    if (c.detail) row.details.add(c.detail);
    for (const name of c.names ?? []) row.names.add(name);
    rows.set(key, row);
  }
  return [...rows.values()];
};

/** Each change on a line, in columns: its target, what of it, and any detail, or how many names it changes. Then what's protected, which a teardown leaves. */
export const planLines = ({ changes, warnings, protected: kept = [] }: Pick<Plan, "changes" | "warnings"> & Partial<Pick<Teardown, "protected">>) => [
  ...text.alignedTable([
    ...collapse(changes).map(({ change, details, names }) => [`${change.op} ${change.target}`, change.what, [...details, ...(names.size ? [String(names.size)] : [])].join(", ")]),
    // Lined up with the targets: nothing happens to it.
    ...kept.map(({ target, what }) => [`  ${target}`, what, "protected"]),
  ]),
  ...warnings.map((w) => `! ${w}`),
];

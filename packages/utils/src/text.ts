// Text for people reading a terminal.

/** Rows as lines with each column padded to its widest cell, two spaces apart, without trailing spaces. */
export const alignedTable = (rows: string[][]): string[] => {
  const columns = Math.max(0, ...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
};

/** `one` when `n` is 1, otherwise `many`: a noun (`repo`/`repos`) or a verb (`is`/`are`). */
export const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** `text` with RegExp syntax escaped, to match it literally inside a pattern. */
export const escapeRegExp = (text: string): string => text.replace(REGEXP_SPECIAL, "\\$&");

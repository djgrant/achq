const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

export const text = {
  /** Rows as lines with each column padded to its widest cell, two spaces apart, without trailing spaces. */
  alignedTable: (rows: string[][]) => {
    const columns = Math.max(0, ...rows.map((r) => r.length));
    const widths = Array.from({ length: columns }, (_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
    return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
  },

  plural: (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many),

  escapeRegExp: (s: string) => s.replace(REGEXP_SPECIAL, "\\$&"),

  /** The last `n` lines that aren't empty. */
  tailLines: (s: string, n: number) => s.split("\n").filter(Boolean).slice(-n),

  /** `a, b,,c` as `["a", "b", "c"]`. */
  commaList: (s: string) =>
    s
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
};

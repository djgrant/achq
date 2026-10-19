import { PERMISSION_RANK } from "./constants.ts";

export type Permissions = Record<string, string>;

/** Whether `granted` covers `wanted` (read < write < admin). */
export const covers = (granted: string | undefined, wanted: string) =>
  granted !== undefined && (PERMISSION_RANK[granted] ?? 0) >= (PERMISSION_RANK[wanted] ?? Infinity);

export const maxLevel = (a: string | undefined, b: string) =>
  a !== undefined && (PERMISSION_RANK[a] ?? 0) >= (PERMISSION_RANK[b] ?? 0) ? a : b;

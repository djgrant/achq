import { text } from "./text.ts";

const MINUTE_MS = 60_000;

export const time = {
  MINUTE_MS,

  /** `ms` in whole-or-fractional minutes, as `20 minutes` or `1 minute`. */
  minutes: (ms: number) => {
    const n = ms / MINUTE_MS;
    return `${n} ${text.plural(n, "minute")}`;
  },
};

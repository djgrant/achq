import { ENV } from "@achq/core";
import { KEEP_AWAKE_INTERVAL_MS } from "./constants.ts";

/** Outbound traffic, so the container provider doesn't sleep the container. Undefined on providers that don't need it. */
export const keepAwake = (env: Record<string, string | undefined>) => {
  const url = env[ENV.keepAwakeUrl];
  return url ? () => fetch(url) : undefined;
};

/** Calls `tick` every few minutes until the returned function is called. */
export const stayAwake = (tick: () => void) => {
  const timer = setInterval(tick, KEEP_AWAKE_INTERVAL_MS);
  return () => clearInterval(timer);
};

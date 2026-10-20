import { ENV } from "@achq/core";
import { every } from "@achq/utils/async";
import { KEEP_AWAKE_INTERVAL_MS } from "./constants.ts";

/** Outbound traffic, so the container provider doesn't sleep the container. Undefined on providers that don't need it. */
export const keepAwake = (env: Record<string, string | undefined>) => {
  const url = env[ENV.keepAwakeUrl];
  return url ? () => fetch(url) : undefined;
};

export const stayAwake = (tick: () => void) => every(KEEP_AWAKE_INTERVAL_MS, tick);

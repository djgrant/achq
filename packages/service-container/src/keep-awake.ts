import { ENV } from "@achq/core";
import { async } from "@achq/utils/async";
import { KEEP_AWAKE_INTERVAL_MS } from "./constants.ts";
import type { Vars } from "@achq/utils/env";

/** Outbound traffic, so the container provider doesn't sleep the container. Undefined on providers that don't need it. */
export const keepAwake = (env: Vars) => {
  const url = env[ENV.keepAwakeUrl];
  return url ? () => fetch(url) : undefined;
};

export const stayAwake = (tick: () => void) => async.every(KEEP_AWAKE_INTERVAL_MS, tick);

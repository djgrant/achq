import { KEEP_AWAKE_INTERVAL_MS, KEEP_AWAKE_URL } from "./constants.ts";

/** Outbound traffic, so the host doesn't sleep the container. */
export const ping = () => fetch(KEEP_AWAKE_URL);

/** Calls `tick` every few minutes until the returned function is called. */
export const stayAwake = (tick: () => void) => {
  const timer = setInterval(tick, KEEP_AWAKE_INTERVAL_MS);
  return () => clearInterval(timer);
};

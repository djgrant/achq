import type { PolicyData } from "@achq/core";
import { ACCESS, CHANNEL } from "./constants.ts";

/** A GitHub policy goes through its App, the channel's source. */
export const policySource = (policy: PolicyData) =>
  policy.access === ACCESS && typeof policy.app === "string" ? { channel: CHANNEL, source: policy.app } : undefined;

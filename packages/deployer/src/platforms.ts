// The platforms the deployer can put containers on. `achq up` sets ACHQ_PLATFORM to one.
import type { Platform } from "@achq/core";
import { railwayPlatform } from "@achq/railway/runtime";

const PLATFORMS: Record<string, Platform> = { [railwayPlatform.id]: railwayPlatform };

export const platformNamed = (id: string) => {
  const platform = PLATFORMS[id];
  if (!platform) throw new Error(`The deployer doesn't know the platform "${id}"; it knows ${Object.keys(PLATFORMS).join(", ")}`);
  return platform;
};

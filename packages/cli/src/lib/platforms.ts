// The platforms the CLI knows. The infra's router and deployer name one; a
// container's location in ACHQ_STATUS names one too.
import type { Platform } from "@achq/core";
import { railwayPlatform } from "@achq/railway/runtime";

const PLATFORMS: Record<string, Platform> = { [railwayPlatform.id]: railwayPlatform };

export const findPlatform = (id: string | undefined) => (id ? PLATFORMS[id] : undefined);

export const platformNamed = (id: string) => {
  const platform = findPlatform(id);
  if (!platform) throw new Error(`achq doesn't know the platform "${id}"; it knows ${Object.keys(PLATFORMS).join(", ")}`);
  return platform;
};

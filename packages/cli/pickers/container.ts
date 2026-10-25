import type { ContainerShell, Status } from "@achq/core";
import { findContainerProvider } from "achq/registry";

export type Located = { name: string; location: Record<string, string>; shell: ContainerShell };

/** The containers ACHQ_STATUS says the repo has, that a container provider achq knows can reach. */
export const containersOf = (status: Status) =>
  (status.containers ?? []).flatMap((c) => {
    const shell = findContainerProvider(c.location.containerProvider)?.shell;
    return shell?.reachable(c.location) ? [{ name: c.name, location: c.location, shell }] : [];
  });

/** The one container, the one `wanted` names, or `undefined` when the caller has to ask. */
export const pickContainer = (containers: Located[], wanted?: string, repo = "The repo") => {
  if (wanted) {
    const found = containers.find((c) => c.name === wanted);
    if (!found) throw new Error(`No container ${wanted}; there's ${containers.map((c) => c.name).join(", ") || "none"}`);
    return found;
  }
  if (!containers.length) throw new Error(`${repo} has no containers yet. \`achq repo status\` shows how its last deploy went.`);
  return containers.length === 1 ? containers[0] : undefined;
};

import type { ContainerShell, Status } from "@achq/core";
import { findContainerHost } from "achq/registry";

export type Located = { name: string; location: Record<string, string>; shell: ContainerShell };

/** The containers ACHQ_STATUS says the repo has, that a container host achq knows can reach. */
export const containersOf = (status: Status): Located[] =>
  (status.containers ?? []).flatMap((c) => {
    // `platform` is the key before it was `containerHost`: an unchanged repo keeps its old ACHQ_STATUS. Drop it once every repo has redeployed.
    const shell = findContainerHost(c.location.containerHost ?? c.location.platform)?.shell;
    return shell?.reachable(c.location) ? [{ name: c.name, location: c.location, shell }] : [];
  });

/** The one container, the one `wanted` names, or `undefined` when the caller has to ask. */
export const pickContainer = (containers: Located[], wanted?: string) => {
  if (wanted) {
    const found = containers.find((c) => c.name === wanted);
    if (!found) throw new Error(`No container ${wanted}; there's ${containers.map((c) => c.name).join(", ") || "none"}`);
    return found;
  }
  if (!containers.length) throw new Error("ACHQ_STATUS lists no containers. Has the repo deployed? (achq status)");
  return containers.length === 1 ? containers[0] : undefined;
};

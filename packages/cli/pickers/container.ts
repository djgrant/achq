import type { Status } from "@achq/core";

/** The containers ACHQ_STATUS says the repo has. */
export const containersOf = (status: Status) => (status.containers ?? []).map((c) => ({ name: c.name }));

/** The one container, the one `wanted` names, or `undefined` when the caller has to ask. */
export const pickContainer = <C extends { name: string }>(containers: C[], wanted?: string, repo = "The repo") => {
  if (wanted) {
    const found = containers.find((c) => c.name === wanted);
    if (!found) throw new Error(`No container ${wanted}; there's ${containers.map((c) => c.name).join(", ") || "none"}`);
    return found;
  }
  if (!containers.length) throw new Error(`${repo} has no containers yet. \`achq repo status\` shows how its last deploy went.`);
  return containers.length === 1 ? containers[0] : undefined;
};

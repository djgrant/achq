import type { Status } from "@achq/core";

export type Located = { name: string; platform: string; project: string; environment: string; service: string };

/** The containers ACHQ_STATUS says the repo has, with where to find them. */
export const containersOf = (status: Status): Located[] =>
  (status.containers ?? []).flatMap((c) => {
    const { platform, project, environment, service } = c.location;
    return platform === "railway" && project && environment && service ? [{ name: c.name, platform, project, environment, service }] : [];
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

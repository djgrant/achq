import type { Provider } from "@achq/reconcile";
import type { ProjectSnapshot, RailwayClient } from "../../api.ts";

/** Where in Railway a resource lives. */
export type Place = { projectId: string; environmentId: string };

export type ProjectParams = { name: string; workspaceId?: string };
export type Project = Place & { name: string };

const placeOf = (p: ProjectSnapshot): Project => ({ projectId: p.id, environmentId: p.environmentId, name: p.name });

export const project = (railway: RailwayClient): Provider<ProjectParams, Project> => ({
  schema: { name: { kind: "key" } },
  read: async ({ name, workspaceId }) => {
    const found = await railway.projectByName(name, workspaceId);
    return found && placeOf(await railway.project(found.id));
  },
  create: async ({ name, workspaceId }) => placeOf(await railway.project(await railway.createProject(name, await railway.workspaceId(workspaceId)))),
});

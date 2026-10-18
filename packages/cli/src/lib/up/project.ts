import type { ProjectSnapshot, RailwayClient } from "@achq/railway/api";
import type { Target } from "@achq/railway/runtime";

/** The infra's Railway project, created unless it's a dry run. Without one yet, the target is empty. */
export const railwayProject = async (
  railway: RailwayClient,
  name: string,
  options: { workspaceId?: string; dryRun: boolean; log: (line: string) => void },
): Promise<{ project?: ProjectSnapshot; target: Target }> => {
  let project: ProjectSnapshot | undefined;
  const found = await railway.projectByName(name, options.workspaceId);
  if (found) {
    project = await railway.project(found.id);
  } else {
    options.log(`  + railway project ${name}`);
    if (!options.dryRun) project = await railway.project(await railway.createProject(name, await railway.workspaceId(options.workspaceId)));
  }
  return { project, target: project ? { projectId: project.id, environmentId: project.environmentId } : {} };
};

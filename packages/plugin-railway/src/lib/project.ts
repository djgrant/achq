import { type Change, type Context, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { optionalEnv } from "@achq/utils/env";
import type { ProjectAt, ProjectSnapshot } from "@achq/utils/railway";
import { RAILWAY_ENV } from "./constants.ts";
import { railwayFromEnv, workspaceId } from "./railway.ts";

export type At = ProjectAt;

type Props = { name: string };

/** Where a project puts its services: its default environment. */
const placeOf = (project: ProjectSnapshot): At => ({ projectId: project.id, environmentId: project.environmentId });

/** A Railway project, found by name in RAILWAY_WORKSPACE_ID, or the token's only workspace. */
export class Project extends ManagedResource<Props, At, At, "create"> {
  readonly kind = "railway-project";

  async read({ name }: Props, ctx: Context) {
    const railway = railwayFromEnv(ctx.env);
    const found = await railway.projectByName(name, optionalEnv(ctx.env, RAILWAY_ENV.workspace));
    if (!found) return undefined;
    return placeOf(await railway.readProject(found.id));
  }

  diff(_: Props, current: At | undefined): "create"[] {
    return current ? [] : ["create"];
  }

  describe(_: "create", { name }: Props): Change {
    return { op: "+", target: `railway project ${name}` };
  }

  planned(_: Props, current: At | undefined): Planned<At> {
    return current ?? { projectId: UNKNOWN, environmentId: UNKNOWN };
  }

  async apply({ name }: Props, _current: At | undefined, _changes: "create"[], ctx: Context) {
    const railway = railwayFromEnv(ctx.env);
    const workspace = await workspaceId(railway, ctx.env);
    const projectId = await railway.createProject(name, workspace);
    return placeOf(await railway.readProject(projectId));
  }

  at() {
    return { projectId: this.out("projectId"), environmentId: this.out("environmentId") };
  }
}

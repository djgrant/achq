import { type Change, type Context, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { Env } from "@achq/utils/env";
import { type ProjectAt, type ProjectSnapshot, RailwayError } from "@achq/utils/railway";
import { RAILWAY_ENV } from "./constants.ts";
import { railwayFromEnv } from "./railway.ts";

type Props = { name: string };

/** Where a project puts its services: its default environment. */
const placeOf = (project: ProjectSnapshot) => ({ projectId: project.id, environmentId: project.environmentId });

/** A Railway project, found by name in RAILWAY_WORKSPACE_ID, or the token's only workspace. */
export class Project extends ManagedResource<Props, ProjectAt, ProjectAt, "create"> {
  readonly kind = "railway-project";

  async read({ name }: Props, ctx: Context) {
    const railway = railwayFromEnv(ctx.env);
    const found = await railway.projectByName(name, new Env(ctx.env).optional(RAILWAY_ENV.workspace));
    if (!found) return undefined;
    return placeOf(await railway.readProject(found.id));
  }

  diff(_: Props, current: ProjectAt | undefined): "create"[] {
    return current ? [] : ["create"];
  }

  describe(_: "create", { name }: Props): Change {
    return { op: "+", target: name, detail: "railway project" };
  }

  planned(_: Props, current: ProjectAt | undefined): Planned<ProjectAt> {
    return current ?? { projectId: UNKNOWN, environmentId: UNKNOWN };
  }

  async apply({ name }: Props, _current: ProjectAt | undefined, _changes: "create"[], ctx: Context) {
    const railway = railwayFromEnv(ctx.env);
    let workspace = new Env(ctx.env).optional(RAILWAY_ENV.workspace);
    if (!workspace) {
      const workspaces = await railway.workspaces();
      const list = workspaces.map((w) => `${w.name}: ${w.id}`).join(", ");
      if (workspaces.length !== 1) throw new RailwayError(`Set ${RAILWAY_ENV.workspace} to one of your Railway workspaces: ${list}`);
      workspace = workspaces[0]!.id;
    }
    const projectId = await railway.createProject(name, workspace);
    return placeOf(await railway.readProject(projectId));
  }

  at() {
    return { projectId: this.out("projectId"), environmentId: this.out("environmentId") };
  }
}

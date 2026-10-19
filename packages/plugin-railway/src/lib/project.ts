import { type Change, type Context, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { railwayClient } from "./client.ts";
import { RAILWAY_ENV } from "./constants.ts";

/** Where a service is. */
export type At = { projectId: string; environmentId: string };

type Props = { name: string };

/** A Railway project, found by name in RAILWAY_WORKSPACE_ID, or the token's only workspace. */
export class Project extends ManagedResource<Props, At, At, "create"> {
  readonly kind = "railway-project";

  async read({ name }: Props, ctx: Context) {
    const railway = railwayClient(ctx.env);
    const found = await railway.projectByName(name, ctx.env[RAILWAY_ENV.workspace]);
    if (!found) return undefined;
    const { id, environmentId } = await railway.project(found.id);
    return { projectId: id, environmentId };
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
    const railway = railwayClient(ctx.env);
    const { id, environmentId } = await railway.project(await railway.createProject(name, await railway.workspaceId(ctx.env[RAILWAY_ENV.workspace])));
    return { projectId: id, environmentId };
  }

  /** Where it puts a service. */
  at() {
    return { projectId: this.out("projectId"), environmentId: this.out("environmentId") };
  }
}

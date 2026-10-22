import { type Change, type Context, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { cloudflareFromEnv } from "./cloudflare.ts";

type Props = { name: string };

/** The account's `<subdomain>.workers.dev`, which the project's Workers are public on. */
type State = { namespaceId?: string; bucket: boolean; workersDev: string };
type Outputs = { namespaceId: string; bucket: string; workersDev: string };
type ProjectChange = "namespace" | "bucket";

/**
 * What an infra's Workers share on the account: a KV namespace, where each
 * one's variables are kept readable, and an R2 bucket, where containers
 * archive their /data. Both are named after the project.
 */
export class Project extends ManagedResource<Props, State, Outputs, ProjectChange> {
  readonly kind = "cloudflare-project";

  async read({ name }: Props, ctx: Context) {
    const cf = cloudflareFromEnv(ctx.env);
    const [namespaces, bucket, subdomain] = await Promise.all([cf.kv.namespaces(), cf.r2.exists(name), cf.workers.subdomain()]);
    if (!subdomain) throw new Error(`Cloudflare account ${cf.accountId} has no workers.dev subdomain yet; choose one at https://dash.cloudflare.com/${cf.accountId}/workers-and-pages`);
    return { namespaceId: namespaces.find((n) => n.title === name)?.id, bucket, workersDev: `${subdomain}.workers.dev` };
  }

  diff(_: Props, current: State): ProjectChange[] {
    return [...(current.namespaceId ? [] : ["namespace" as const]), ...(current.bucket ? [] : ["bucket" as const])];
  }

  describe(change: ProjectChange, { name }: Props): Change {
    return { op: "+", target: name, what: change === "namespace" ? "kv namespace" : "r2 bucket" };
  }

  planned({ name }: Props, current: State): Planned<Outputs> {
    return { namespaceId: current.namespaceId ?? UNKNOWN, bucket: name, workersDev: current.workersDev };
  }

  async apply({ name }: Props, current: State, changes: ProjectChange[], ctx: Context) {
    const cf = cloudflareFromEnv(ctx.env);
    let namespaceId = current.namespaceId;
    for (const change of changes) {
      if (change === "namespace") namespaceId = await cf.kv.createNamespace(name);
      else await cf.r2.create(name);
    }
    return { namespaceId: namespaceId!, bucket: name, workersDev: current.workersDev };
  }

  at() {
    return { namespaceId: this.out("namespaceId"), bucket: this.out("bucket"), workersDev: this.out("workersDev") };
  }
}

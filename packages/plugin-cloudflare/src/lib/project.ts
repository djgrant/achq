import { type Context, CreateOnlyResource, DataSource, type Planned, Resource, type ResourceOptions, UNKNOWN } from "@achq/core";
import { connect } from "./cloudflare.ts";
import { PLUGIN } from "../plugin.ts";

type Named = { name: string };

/** The account, as your sign-in reaches it, and its `<subdomain>.workers.dev`, which the project's Workers are public on. It isn't achq's, so it's only read. */
type AccountState = { accountId: string; workersDev: string };

export class Account extends DataSource<{}, AccountState> {
  readonly plugin = PLUGIN;
  readonly kind = "cloudflare-account";

  async read(_: {}, ctx: Context) {
    const cf = await connect(ctx.env);
    const subdomain = await cf.workers.subdomain();
    if (!subdomain) throw new Error(`Cloudflare account ${cf.accountId} has no workers.dev subdomain yet; choose one at https://dash.cloudflare.com/${cf.accountId}/workers-and-pages`);
    return { accountId: cf.accountId, workersDev: `${subdomain}.workers.dev` };
  }
}

/** A KV namespace, by its title. */
export class Namespace extends CreateOnlyResource<Named, { id: string }, { namespaceId: string }> {
  readonly plugin = PLUGIN;
  readonly kind = "cloudflare-kv-namespace";
  readonly what = "kv namespace";

  async read({ name }: Named, ctx: Context) {
    const found = (await (await connect(ctx.env)).kv.namespaces()).find((n) => n.title === name);
    return found && { id: found.id };
  }

  planned(_: Named, current: { id: string } | undefined): Planned<{ namespaceId: string }> {
    return { namespaceId: current?.id ?? UNKNOWN };
  }

  async apply({ name }: Named, _current: undefined, _changes: "create"[], ctx: Context) {
    return { namespaceId: await (await connect(ctx.env)).kv.createNamespace(name) };
  }

  /** And every value in it. */
  async destroy(_: Named, { id }: { id: string }, ctx: Context) {
    await (await connect(ctx.env)).kv.deleteNamespace(id);
  }
}

/** An R2 bucket. */
export class Bucket extends CreateOnlyResource<Named, {}, { bucket: string }> {
  readonly plugin = PLUGIN;
  readonly kind = "cloudflare-r2-bucket";
  readonly what = "r2 bucket";

  async read({ name }: Named, ctx: Context) {
    return (await (await connect(ctx.env)).r2.exists(name)) ? {} : undefined;
  }

  planned({ name }: Named) {
    return { bucket: name };
  }

  async apply({ name }: Named, _current: undefined, _changes: "create"[], ctx: Context) {
    await (await connect(ctx.env)).r2.create(name);
    return { bucket: name };
  }

  /** Emptied first: Cloudflare deletes only an empty bucket. */
  async destroy({ name }: Named, _current: {}, ctx: Context) {
    const cf = await connect(ctx.env);
    for (const key of await cf.r2.keys(name)) await cf.r2.deleteObject(name, key);
    await cf.r2.delete(name);
  }
}

/**
 * What an infra's Workers share on the account: a KV namespace, where each
 * one's variables are kept readable, and an R2 bucket, where containers
 * archive their /data. Both are named after the project.
 */
export class Project extends Resource {
  readonly plugin = PLUGIN;
  readonly kind = "cloudflare-project";
  private readonly account: Account;
  private readonly namespace: Namespace;
  private readonly bucket: Bucket;

  constructor(name: string, readonly inputs: Named, options: ResourceOptions) {
    super(name, options);
    this.account = new Account("account", {}, { parent: this });
    this.namespace = new Namespace("namespace", { name: inputs.name }, { parent: this });
    this.bucket = new Bucket("bucket", { name: inputs.name }, { parent: this });
  }

  children() {
    return [this.account, this.namespace, this.bucket];
  }

  at() {
    return {
      accountId: this.account.out("accountId"),
      namespaceId: this.namespace.out("namespaceId"),
      bucket: this.bucket.out("bucket"),
      workersDev: this.account.out("workersDev"),
    };
  }
}

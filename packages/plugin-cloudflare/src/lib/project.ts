import { type Change, type Context, ManagedResource, type Planned, Resource, type ResourceOptions, UNKNOWN } from "@achq/core";
import { connect } from "./cloudflare.ts";

type Named = { name: string };

/** The account, as your sign-in reaches it, and its `<subdomain>.workers.dev`, which the project's Workers are public on. Read, never changed: it isn't achq's. */
type AccountState = { accountId: string; workersDev: string };

export class Account extends ManagedResource<{}, AccountState, AccountState, never> {
  readonly kind = "cloudflare-account";

  async read(_: {}, ctx: Context) {
    const cf = await connect(ctx.env);
    const subdomain = await cf.workers.subdomain();
    if (!subdomain) throw new Error(`Cloudflare account ${cf.accountId} has no workers.dev subdomain yet; choose one at https://dash.cloudflare.com/${cf.accountId}/workers-and-pages`);
    return { accountId: cf.accountId, workersDev: `${subdomain}.workers.dev` };
  }

  diff(): never[] {
    return [];
  }

  describe(): Change {
    throw new Error("An account is never changed");
  }

  planned(_: {}, current: AccountState) {
    return current;
  }

  async apply(_: {}, current: AccountState) {
    return current;
  }
}

/** A KV namespace, by its title. */
export class Namespace extends ManagedResource<Named, { id: string }, { namespaceId: string }, "create"> {
  readonly kind = "cloudflare-kv-namespace";

  async read({ name }: Named, ctx: Context) {
    const found = (await (await connect(ctx.env)).kv.namespaces()).find((n) => n.title === name);
    return found && { id: found.id };
  }

  diff(_: Named, current: { id: string } | undefined): "create"[] {
    return current ? [] : ["create"];
  }

  describe(_: "create", { name }: Named): Change {
    return { op: "+", target: name, what: "kv namespace" };
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
export class Bucket extends ManagedResource<Named, {}, { bucket: string }, "create"> {
  readonly kind = "cloudflare-r2-bucket";

  async read({ name }: Named, ctx: Context) {
    return (await (await connect(ctx.env)).r2.exists(name)) ? {} : undefined;
  }

  diff(_: Named, current: {} | undefined): "create"[] {
    return current ? [] : ["create"];
  }

  describe(_: "create", { name }: Named): Change {
    return { op: "+", target: name, what: "r2 bucket" };
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

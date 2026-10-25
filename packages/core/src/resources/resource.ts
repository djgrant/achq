import type { Vars } from "@achq/utils/env";
import type { Change } from "../engine/plan.ts";
import { hasUnknown, type Inputs, Output, type Planned, UNKNOWN, type Unknown } from "../engine/values.ts";
import { RESOURCE_NAME } from "../model/resource-data.ts";

/** The resources the config being evaluated has declared so far. */
let declarations: Resource[] = [];

/** Starts afresh, for evaluating another config in the same process. */
export const resetDeclarations = () => {
  declarations = [];
};

export const declared = () => [...declarations];

/**
 * Where `achq infra up` keeps a secret it makes once and reuses on another
 * router or machine, e.g. a GitHub App's private key: items by name, each a
 * set of named fields. A `VaultProvider` makes one.
 */
export interface Vault {
  /** The item's fields, or undefined if there's no item of that name. */
  read(item: string): Promise<Record<string, string> | undefined>;
  /** Keeps `fields` as the item, in place of any item of that name. */
  write(item: string, fields: Record<string, string>): Promise<void>;
}

/** What planning and applying give a resource. */
export type Context = {
  env: Vars;
  log(line: string): void;
  /** Opens `url` in your browser to `what`, e.g. to create an App. Only the CLI can, and only while applying. */
  open?(url: string, what: string): Promise<void>;
  /** Asks you for a secret, e.g. a token you just made in the browser `open` opened, without echoing what you type. Only the CLI can, and only while applying. */
  prompt?(message: string): Promise<string>;
  /** Where `achq infra up` keeps secrets it makes, to reuse them on other routers and machines: the vault `achq.config.ts` names, if it names one. Only the CLI has one. */
  vault?: Vault;
  /** Makes a GENERATED value. */
  newSecret(): string;
  sleep(ms: number): Promise<void>;
};

export type ResourceOptions = {
  parent?: Resource;
  /** False for a resource achq makes rather than a config declares, e.g. a container's service: it isn't declared, and its name is its host's. */
  declared?: boolean;
};

/**
 * Anything declared in a config. Constructing one declares it, unless it's
 * another resource's child (its parent's business, planned with it and named
 * within it) or achq made it.
 */
export abstract class Resource {
  abstract readonly kind: string;
  readonly parent?: Resource;

  constructor(
    readonly name: string,
    options: ResourceOptions = {},
  ) {
    this.parent = options.parent;
    if (this.parent || options.declared === false) return;
    if (!RESOURCE_NAME.test(name)) throw new Error(`Resource name "${name}" must be lowercase letters, digits and dashes, starting with a letter`);
    declarations.push(this);
  }

  /** What it's made of. Called once, when it's planned, so parts can still be declared until then. */
  children(_ctx: Context): Resource[] {
    return [];
  }
}

/**
 * A resource the engine reads, and others can take outputs from: a data
 * source, which it only reads, or a managed resource, which it keeps in shape.
 * Planned after what its props take outputs from, and what it's `after`.
 */
export abstract class ReadableResource<P = any, O = any> extends Resource {
  constructor(
    name: string,
    readonly props: Inputs<P>,
    options: ResourceOptions & { after?: ReadableResource[] } = {},
  ) {
    super(name, options);
    this.after = options.after ?? [];
  }

  /** What it must follow without taking an input from it. */
  readonly after: ReadableResource[];

  /** What it is now. */
  abstract read(props: P, ctx: Context): Promise<unknown>;

  out<K extends keyof O>(key: K): Output<O[K]> {
    return new Output([this], (outputs) => (outputs.has(this) ? ((outputs.get(this) as Planned<O>)[key] as O[K] | Unknown) : UNKNOWN));
  }

  /** All its outputs, unknown while any of them is. */
  outputs(): Output<O> {
    return new Output([this], (outputs) => (outputs.has(this) && !hasUnknown(outputs.get(this)) ? (outputs.get(this) as O) : UNKNOWN));
  }
}

/**
 * What achq only reads, e.g. the account the infra is on: it's never changed,
 * deleted or listed, only taken outputs from. Its props are known when it's
 * read.
 */
export abstract class DataSource<P = any, O = any> extends ReadableResource<P, O> {
  /** What it is. Throws if it isn't there: what reads it can't go on without it. */
  abstract read(props: P, ctx: Context): Promise<O>;
}

/**
 * A resource achq keeps in shape. The engine reads, compares and applies; the
 * resource says how.
 *
 * Its methods take its props resolved. When planning, any part not known yet
 * is UNKNOWN (check with `known`): a resource whose id is unknown doesn't
 * exist yet. When applying, every part is known, and the engine reads and
 * compares again if any changed since.
 */
export abstract class ManagedResource<P = any, S = any, O = any, C = any> extends ReadableResource<P, O> {
  constructor(name: string, props: Inputs<P>, options: ResourceOptions & { after?: ReadableResource[]; protect?: boolean } = {}) {
    super(name, props, options);
    this.protect = options.protect ?? false;
  }

  /** Never deleted: `achq infra down` lists it instead. */
  readonly protect: boolean;

  /** What exists now, or undefined if it doesn't. */
  abstract read(props: P, ctx: Context): Promise<S | undefined>;
  /** What applying would change to make `current` match `props`: none when it matches. Reads nothing. */
  abstract diff(props: P, current: S | undefined, ctx: Context): C[];
  /** A change, for printing. Names secrets, never their values. */
  abstract describe(change: C, props: P): Change;
  /** Its outputs once `changes` are applied: UNKNOWN where only applying can tell. */
  abstract planned(props: P, current: S | undefined, changes: C[]): Planned<O>;
  /** Makes `changes`. Only called with some. */
  abstract apply(props: P, current: S | undefined, changes: C[], ctx: Context): Promise<O>;
  /** What achq can't change itself, e.g. an App's permissions. Printed, never applied. */
  check?(props: P, current: S): string[];

  /**
   * Deletes it. Only `achq infra down` calls this, each before what it depends
   * on, unless it's protected. One without it goes with what it's part of,
   * e.g. a Worker's variables with the namespace they're kept in. Deleting one
   * that's gone since it was read succeeds.
   */
  destroy?(props: P, current: S, ctx: Context): Promise<void>;
  /** For one that's protected: the page where you delete it yourself, which `achq infra down` opens once it's deleted the rest. */
  deletePage?(props: P, current: S, ctx: Context): string;
}

/**
 * A managed resource achq only ever creates: once it exists, there's nothing
 * to change. A plan names it by its props' `name`, as `what` it is.
 */
export abstract class CreateOnlyResource<P extends { name: string } = any, S = any, O = any> extends ManagedResource<P, S, O, "create"> {
  /** What it is, in a plan: e.g. `kv namespace`. */
  abstract readonly what: string;

  diff(_: P, current: S | undefined): "create"[] {
    return current ? [] : ["create"];
  }

  describe(_: "create", { name }: P): Change {
    return { op: "+", target: name, what: this.what };
  }
}

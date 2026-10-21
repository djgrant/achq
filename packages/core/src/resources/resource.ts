import type { Vars } from "@achq/utils/env";
import type { Change } from "../engine/plan.ts";
import { hasUnknown, type Inputs, Output, type Planned, UNKNOWN, type Unknown } from "../engine/values.ts";

export const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** The resources the config being evaluated has declared so far. */
let declarations: Resource[] = [];

/** Starts afresh, for evaluating another config in the same process. */
export const resetDeclarations = () => {
  declarations = [];
};

export const declared = () => [...declarations];

/** What planning and applying give a resource. */
export type Context = {
  env: Vars;
  log(line: string): void;
  /** Opens `url` in your browser to `what`, e.g. to create an App. Only the CLI can, and only while applying. */
  open?(url: string, what: string): Promise<void>;
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
 * A resource achq keeps in shape. The engine reads, compares and applies; the
 * resource says how.
 *
 * Its methods take its props resolved. When planning, any part not known yet
 * is UNKNOWN (check with `known`): a resource whose id is unknown doesn't
 * exist yet. When applying, every part is known, and the engine reads and
 * compares again if any changed since.
 */
export abstract class ManagedResource<P = any, S = any, O = any, C = any> extends Resource {
  constructor(
    name: string,
    readonly props: Inputs<P>,
    options: ResourceOptions & { after?: ManagedResource[] } = {},
  ) {
    super(name, options);
    this.after = options.after ?? [];
  }

  /** What it must follow without taking an input from it. */
  readonly after: ManagedResource[];

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

  out<K extends keyof O>(key: K): Output<O[K]> {
    return new Output([this], (outputs) => (outputs.has(this) ? ((outputs.get(this) as Planned<O>)[key] as O[K] | Unknown) : UNKNOWN));
  }

  /** All its outputs, unknown while any of them is. */
  outputs(): Output<O> {
    return new Output([this], (outputs) => (outputs.has(this) && !hasUnknown(outputs.get(this)) ? (outputs.get(this) as O) : UNKNOWN));
  }
}

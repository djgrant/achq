import { type Json, json } from "@achq/utils/json";
import { brand, branded } from "../engine/brand.ts";
import type { PolicyData, SelectorData } from "../model/resource-data.ts";
import { PLUGIN } from "../plugin.ts";
import { type Plugin, Resource } from "./resource.ts";

const POLICY = brand("policy");
const CONTAINER = brand("container");
const WORKSPACE = brand("workspace");
const AGENT = brand("agent");
const TRIGGER = brand("trigger");

/** Which events start a run. Plain data, matched in the router and the container. */
export class EventSelector {
  constructor(readonly data: SelectorData) {
    json.from(data, "event selector");
  }
}

/** Which threads a workspace claims. Plain data, matched in the router. */
export class ThreadSelector {
  constructor(readonly data: SelectorData) {
    json.from(data, "thread selector");
  }
}

/** What a container can access. Interpreted by its policy provider. */
export class Policy extends Resource {
  readonly [POLICY] = true;
  readonly kind = "policy";
  /** Its policy provider's package: core's, unless a plugin's subclass says otherwise. */
  readonly plugin: Plugin = PLUGIN;
  constructor(
    name: string,
    readonly policy: PolicyData,
  ) {
    super(name);
    json.from(policy, `policy ${name}`);
  }
}

export type ContainerInputs = {
  /** A Dockerfile, relative to `.achq/`. */
  image: string;
  policies?: Policy[];
  /** Written at startup. A string is a path relative to `.achq/`; anything else is written as JSON. */
  files?: Record<string, string | Json>;
};

export class Container extends Resource {
  readonly [CONTAINER] = true;
  readonly kind = "container";
  readonly plugin = PLUGIN;
  constructor(
    name: string,
    readonly inputs: ContainerInputs,
  ) {
    super(name);
  }
}

export type WorkspaceInputs = {
  container: Container;
  threads: ThreadSelector;
  /** Branch template, e.g. `issue-{number}`. */
  branch: string;
  /** The branch a new thread's worktree starts from. */
  base: string;
};

export class Workspace extends Resource {
  readonly [WORKSPACE] = true;
  readonly kind = "workspace";
  readonly plugin = PLUGIN;
  constructor(
    name: string,
    readonly inputs: WorkspaceInputs,
  ) {
    super(name);
  }
}

/** Who does the work. Subclasses (`claude.Agent`) hold config, which can include code. */
export abstract class Agent<Config = unknown> extends Resource {
  readonly [AGENT] = true;
  readonly kind = "agent";
  abstract readonly runtime: string;
  constructor(
    name: string,
    readonly config: Config,
  ) {
    super(name);
  }
}

export class Trigger extends Resource {
  readonly [TRIGGER] = true;
  readonly kind = "trigger";
  readonly plugin = PLUGIN;
  constructor(
    name: string,
    readonly inputs: { event: EventSelector; agent: Agent },
  ) {
    super(name);
  }
}

export const isPolicy = branded<Policy>(POLICY);
export const isContainer = branded<Container>(CONTAINER);
export const isWorkspace = branded<Workspace>(WORKSPACE);
export const isAgent = branded<Agent>(AGENT);
export const isTrigger = branded<Trigger>(TRIGGER);

import { type Json, json } from "@achq/utils/json";
import type { PolicyData, SelectorData } from "../model/resource-data.ts";
import { Resource } from "./resource.ts";

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
  readonly kind = "policy";
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
  readonly kind = "container";
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
  readonly kind = "workspace";
  constructor(
    name: string,
    readonly inputs: WorkspaceInputs,
  ) {
    super(name);
  }
}

/** Who does the work. Subclasses (`claude.Agent`) hold config, which can include code. */
export abstract class Agent<Config = unknown> extends Resource {
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
  readonly kind = "trigger";
  constructor(
    name: string,
    readonly inputs: { event: EventSelector; agent: Agent },
  ) {
    super(name);
  }
}

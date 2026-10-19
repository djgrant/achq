// What a repo's config declares.
import { type Data, toData } from "./data.ts";
import { Resource } from "./resource.ts";

/** Selector and policy data always says which channel or policy provider interprets it. */
export type SelectorData = { channel: string; source: string; [key: string]: Data };
/**
 * `source`, when present, is the channel source the policy grants through, e.g. a GitHub App.
 * A repo's config always names one; the deployer's own policy leaves it to the policy provider.
 */
export type PolicyData = { provider: string; [key: string]: Data } & { source?: string };

/** Which events start a run. Plain data, matched in the router and the container. */
export class EventSelector {
  constructor(readonly data: SelectorData) {
    toData(data, "event selector");
  }
}

/** Which threads a workspace claims. Plain data, matched in the router and the container. */
export class ThreadSelector {
  constructor(readonly data: SelectorData) {
    toData(data, "thread selector");
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
    toData(policy, `policy ${name}`);
  }
}

export type ContainerInputs = {
  /** A Dockerfile, relative to `.achq/`. */
  image: string;
  policies?: Policy[];
  /** Written at startup. A string is a path relative to `.achq/`; anything else is written as JSON. */
  files?: Record<string, string | Data>;
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

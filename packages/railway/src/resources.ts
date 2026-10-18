// The router, the deployer and the containers it deploys share one Railway
// project, for its private network.
import * as core from "@achq/core";

/** The router, as a Railway service in `project`: public, always on, with a volume. */
export class Router extends core.Router {
  constructor(
    name: string,
    readonly inputs: { project: string },
  ) {
    super(name);
  }
}

/** The deployer, as a Railway service in `project`: private, sleeping when idle. It deploys containers to the same project. */
export class Deployer extends core.Deployer {
  constructor(
    name: string,
    readonly inputs: { project: string; router: core.Router; owners: string[] },
  ) {
    super(name);
  }
}

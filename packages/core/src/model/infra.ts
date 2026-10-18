// The infra's resources say what to run. A platform package (railway) subclasses
// them with where to run it, and `achq up` reads that.
import { registered, resetRegistry } from "./registry.ts";
import { Resource } from "./resources.ts";

/** Receives, stores, filters and forwards events, and mints credentials. */
export abstract class Router extends Resource {
  readonly kind = "router";
}

/** Evaluates repo config and deploys its containers. */
export abstract class Deployer extends Resource {
  readonly kind = "deployer";
  abstract readonly inputs: { router: Router; owners: string[] };
}

export type Infra = { resources: Resource[] };

/** The ACHQ infra: `export default achq(() => { … })`. Declares its resources when `achq up` calls it. */
export const achq = (declare: () => void) => (): Infra => {
  resetRegistry();
  declare();
  return { resources: registered() };
};

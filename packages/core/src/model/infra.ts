// The infra's code runs locally under `achq up` and is trusted, so these
// resources can hold host objects with real implementations.
import { registered, resetRegistry, Resource } from "./resources.ts";
import type { ContainerHost } from "../contracts/interfaces.ts";

/** Where the router runs: public, always on, with a volume. Implemented per platform. */
export interface RouterHost {
  readonly platform: string;
}

/** Where the deployer runs: private, sleeping when idle. */
export interface DeployerHost {
  readonly platform: string;
}

/** Receives, stores, filters and forwards events, and mints credentials. */
export class Router extends Resource {
  readonly kind = "router";
  constructor(
    name: string,
    readonly inputs: { host: RouterHost },
  ) {
    super(name);
  }
}

/** Evaluates repo config and deploys its containers. */
export class Deployer extends Resource {
  readonly kind = "deployer";
  constructor(
    name: string,
    readonly inputs: { router: Router; host: DeployerHost; containerHost: ContainerHost & { readonly platform: string }; owners: string[] },
  ) {
    super(name);
  }
}

export type Infra = { resources: Resource[] };

/** The ACHQ infra: `export default achq(() => { … })`. Declares its resources when `achq up` calls it. */
export const achq = (declare: () => void) => (): Infra => {
  resetRegistry();
  declare();
  return { resources: registered() };
};

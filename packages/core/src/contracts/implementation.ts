import type { Vars } from "@achq/utils/env";

/** Something to make sure of before using an implementation from your machine, e.g. that its credentials work. `check` throws if it doesn't hold; `remediation` says what to do. */
export type Check = { label: string; check: () => Promise<void>; remediation?: string[]; documentationUrl?: string };

export type Implementation<T> = {
  readonly id: string;
  create(env: Vars): T;
  /** Variables only the router and deployer have. A container never hands them to an agent, in case they're set anyway. */
  readonly privateEnv: string[];
  /** What the CLI makes sure of before it uses this implementation with `env`. */
  checks?(env: Vars): Check[];
};

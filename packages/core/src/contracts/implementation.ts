import type { Vars } from "@achq/utils/env";

export type Implementation<T> = {
  readonly id: string;
  create(env: Vars): T;
  /** Variables only the router and deployer have. A container never hands them to an agent, in case they're set anyway. */
  readonly privateEnv: string[];
};

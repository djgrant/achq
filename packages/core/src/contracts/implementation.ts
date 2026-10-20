type Env = Record<string, string | undefined>;

export type Implementation<T> = {
  readonly id: string;
  create(env: Env): T;
  /** Variables only the router and deployer have. A container never hands them to an agent, in case they're set anyway. */
  readonly privateEnv: string[];
};

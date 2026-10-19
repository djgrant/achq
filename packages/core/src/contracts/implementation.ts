// The registry lists each contract's implementations by id. Each side makes
// the ones it needs from its own env, and calls its own part.
type Env = Record<string, string | undefined>;

export type Implementation<T> = {
  readonly id: string;
  create(env: Env): T;
  /** Variables only the router and deployer have. A container never hands them to an agent, in case they're set anyway. */
  readonly privateEnv: string[];
};

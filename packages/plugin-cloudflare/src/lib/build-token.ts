import { type Change, type Context, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { async } from "@achq/utils/async";
import type { BuildToken as Token } from "@achq/utils/cloudflare";
import { cloudflareFromEnv } from "./cloudflare.ts";
import { FLOW_POLL_INTERVAL_MS, FLOW_TIMEOUT_MS } from "./constants.ts";

type Props = {
  /** The token the deployer has, from its variables, if it has one. */
  stored?: string;
  /** A Worker of the infra's, whose Build settings the dashboard creates a token in. */
  worker: string;
};
type State = { tokens: Token[] };
type Outputs = { uuid: string };
type TokenChange = "pick" | "create";

/** The newest token: the API can't say whether one still works, and the newest is likeliest to. */
const newest = (tokens: Token[]) => tokens.at(-1);

/**
 * The account's Workers Builds token, which the deployer builds containers
 * with. The deployer keeps the one it has while the account still lists it;
 * otherwise it takes the newest. An account with none gets one in the
 * dashboard, which only you can do, so it opens there and waits for it.
 */
export class BuildToken extends ManagedResource<Props, State, Outputs, TokenChange> {
  readonly kind = "cloudflare-build-token";

  async read(_: Props, ctx: Context) {
    return { tokens: await cloudflareFromEnv(ctx.env).builds.tokens() };
  }

  diff({ stored }: Props, current: State): TokenChange[] {
    if (stored && current.tokens.some((t) => t.build_token_uuid === stored)) return [];
    return [current.tokens.length ? "pick" : "create"];
  }

  describe(change: TokenChange, { worker }: Props): Change {
    return change === "pick"
      ? { op: "~", target: worker, what: "build token", detail: "the account's newest" }
      : { op: "+", target: worker, what: "build token", detail: "opens Cloudflare to create one" };
  }

  planned({ stored }: Props, current: State, changes: TokenChange[]): Planned<Outputs> {
    if (!changes.length) return { uuid: stored! };
    return { uuid: changes[0] === "pick" ? newest(current.tokens)!.build_token_uuid : UNKNOWN };
  }

  async apply({ worker }: Props, current: State, [change]: TokenChange[], ctx: Context) {
    if (change === "pick") return { uuid: newest(current.tokens)!.build_token_uuid };
    const cf = cloudflareFromEnv(ctx.env);
    if (!ctx.open) throw new Error("Creating a Workers Builds token opens your browser, which only the CLI can do");
    const url = `https://dash.cloudflare.com/${cf.accountId}/workers/services/view/${worker}/production/settings`;
    ctx.log(`  Workers Builds needs an API token to deploy with. Under Build, connect a repository, and choose "Create new token"; you needn't save the connection: ${url}`);
    await ctx.open(url, "create a Workers Builds token");
    const tokens = await async.pollUntil(() => cf.builds.tokens(), (t) => t.length > 0, { intervalMs: FLOW_POLL_INTERVAL_MS, timeoutMs: FLOW_TIMEOUT_MS, sleep: ctx.sleep });
    if (!tokens) throw new Error(`The account has no Workers Builds token after ${FLOW_TIMEOUT_MS / 60_000} minutes`);
    return { uuid: newest(tokens)!.build_token_uuid };
  }
}

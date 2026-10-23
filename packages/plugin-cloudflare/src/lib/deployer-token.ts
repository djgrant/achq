import { type Change, type Context, known, ManagedResource } from "@achq/core";
import { connect, deployerTokenPage, deployerTokenProblem, TOKENS_PAGE } from "./cloudflare.ts";
import { CLOUDFLARE_ENV, TOKEN_ATTEMPTS } from "./constants.ts";

type Props = {
  /** The deployer's Worker. */
  worker: string;
  /** Its tag: unknown until it exists. */
  tag: string;
  /** Replaces the token it has: `achq infra up --rotate-deployer-token`. */
  replace: boolean;
};
type State = { has: boolean };
type TokenChange = "create" | "replace";

/**
 * The deployer's own API token, which it builds and runs containers with, as
 * its Worker's secret alone: secrets can't be read back, so it's never on your
 * machine, in the namespace or in its variables. No sign-in can make API
 * tokens, so the dashboard's create-token page opens with its permissions
 * filled in, and you paste what it makes. It's checked before it's set.
 */
export class DeployerToken extends ManagedResource<Props, State, {}, TokenChange> {
  readonly kind = "cloudflare-deployer-token";

  async read({ worker, tag }: Props, ctx: Context) {
    if (!known(tag)) return undefined;
    const cf = await connect(ctx.env);
    return { has: (await cf.workers.secrets(worker)).some((s) => s.name === CLOUDFLARE_ENV.deployerToken) };
  }

  diff({ replace }: Props, current: State | undefined): TokenChange[] {
    if (!current?.has) return ["create"];
    return replace ? ["replace"] : [];
  }

  describe(change: TokenChange, { worker }: Props): Change {
    return change === "create"
      ? { op: "+", target: worker, what: "deployer token", detail: "opens Cloudflare to create it, then asks for it" }
      : { op: "~", target: worker, what: "deployer token", detail: "opens Cloudflare to create a new one, then asks for it" };
  }

  planned() {
    return {};
  }

  /** Your API tokens, where it's the one named after the deployer: only its Worker knows which it is. */
  deletePage() {
    return TOKENS_PAGE;
  }

  async apply({ worker }: Props, _current: State | undefined, _changes: TokenChange[], ctx: Context) {
    const { open, prompt } = ctx;
    if (!open || !prompt) throw new Error("The deployer's Cloudflare token is made in your browser and pasted here, which only `achq infra up` can do");
    const cf = await connect(ctx.env);
    const page = deployerTokenPage(cf.accountId);
    ctx.log("  The deployer needs a Cloudflare API token of its own. Create it with what's filled in, then paste it here. It's kept only as the deployer's secret.");
    await open(page, "create the deployer's Cloudflare token");
    for (let attempt = 1; ; attempt++) {
      const token = (await prompt("The deployer's Cloudflare token")).trim();
      const problem = token ? await deployerTokenProblem(token, cf.accountId, cf.transport.endpoint) : "No token was pasted";
      if (!problem) {
        await cf.workers.putSecret(worker, CLOUDFLARE_ENV.deployerToken, token);
        ctx.log("  ✔ The token works, and it's the deployer's secret now.");
        return {};
      }
      if (attempt >= TOKEN_ATTEMPTS) throw new Error(`${problem}. Run \`achq infra up\` again to make another.`);
      ctx.log(`  ! ${problem}. Paste it again.`);
    }
  }
}

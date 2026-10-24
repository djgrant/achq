import { type Context, type DeclaredVariables, known, VariableGroup } from "@achq/core";
import { connect } from "./cloudflare.ts";

/** `key` is where they're kept in the project's namespace; `target` names them in a plan. */
type Props = { namespaceId: string; key: string; target: string; values: DeclaredVariables };

/** Reads a Worker's variables, as JSON in the project's namespace: none until it has some. */
export const readVariables = async (ctx: Context, namespaceId: string, key: string): Promise<Record<string, string>> => {
  const cf = await connect(ctx.env);
  return (await cf.kv.getJson<Current>(namespaceId, key)) ?? {};
};

/**
 * A group of a Worker's variables, kept readable in the project's KV
 * namespace: Worker secrets can't be read back, and a service's variables and
 * generated keys have to be. What runs gets them as secrets when it's deployed.
 */
export class Variables extends VariableGroup<Props> {
  readonly kind = "cloudflare-variables";

  async read({ namespaceId, key }: Props, ctx: Context) {
    return known(namespaceId) ? readVariables(ctx, namespaceId, key) : undefined;
  }

  protected async store({ namespaceId, key }: Props, set: Record<string, string>, ctx: Context) {
    // Several groups share the one record, so it's read again and merged.
    const stored = await readVariables(ctx, namespaceId, key);
    const cf = await connect(ctx.env);
    await cf.kv.put(namespaceId, key, JSON.stringify({ ...stored, ...set }));
  }

  protected target({ target }: Props) {
    return target;
  }
}

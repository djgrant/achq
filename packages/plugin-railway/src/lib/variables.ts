import { type Context, type DeclaredVariables, known, VariableGroup } from "@achq/core";
import type { ServiceAt } from "@achq/utils/railway";
import { serviceAt } from "./railway.ts";

type Props = { at: ServiceAt; service: string; values: DeclaredVariables };

/** A group of a Railway service's variables, set on the service. */
export class Variables extends VariableGroup<Props> {
  readonly kind = "railway-variables";

  async read({ at }: Props, ctx: Context) {
    return known(at.serviceId) ? serviceAt(ctx.env, at).variables() : undefined;
  }

  protected async store({ at }: Props, set: Record<string, string>, ctx: Context) {
    await serviceAt(ctx.env, at).setVariables(set);
  }

  protected target({ service }: Props) {
    return service;
  }
}

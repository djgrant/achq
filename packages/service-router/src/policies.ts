import type { PolicyData } from "@achq/core";
import type { RouterContext } from "./context.ts";

const providerFor = (ctx: RouterContext, id: string) => {
  const found = ctx.policyProviders.find((p) => p.id === id);
  if (!found) throw new Error(`No policy provider "${id}"`);
  return found;
};

/** One `mint` per policy provider, for the policies that name it. */
export const mint = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const ids = [...new Set(policies.map((p) => p.provider))];
  const minted = await Promise.all(ids.map((id) => providerFor(ctx, id).mint(policies.filter((p) => p.provider === id), repo)));
  return minted.flat();
};

/** Each policy's problems for `repo`, from the policy provider it names. */
export const validate = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const problems = await Promise.all(
    policies.map((p) => {
      const found = ctx.policyProviders.find((x) => x.id === p.provider);
      return found ? found.validate(p, repo) : [`No policy provider "${p.provider}"`];
    }),
  );
  return problems.flat();
};

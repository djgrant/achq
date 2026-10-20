import type { PolicyData } from "@achq/core";
import type { RouterContext } from "./context.ts";

const noProvider = (id: string) => `No policy provider "${id}"`;

const findProvider = (ctx: RouterContext, id: string) => ctx.policyProviders.find((p) => p.id === id);

const providerFor = (ctx: RouterContext, id: string) => {
  const found = findProvider(ctx, id);
  if (!found) throw new Error(noProvider(id));
  return found;
};

/** One `mint` per policy provider, for the policies that name it. */
export const mint = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const ids = [...new Set(policies.map((p) => p.provider))];
  const minted = await Promise.all(ids.map((id) => providerFor(ctx, id).mint(policies.filter((p) => p.provider === id), repo)));
  return minted.flat();
};

/** Each policy's problems for `repo`, from the policy provider it names. A provider nobody has is a problem too. */
export const validate = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const problems = await Promise.all(policies.map((p) => findProvider(ctx, p.provider)?.validate(p, repo) ?? [noProvider(p.provider)]));
  return problems.flat();
};

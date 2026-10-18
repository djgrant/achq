import type { PolicyData } from "@achq/core";
import type { RouterContext } from "./context.ts";

const provider = (ctx: RouterContext, id: string) => {
  const found = ctx.providers.find((p) => p.id === id);
  if (!found) throw new Error(`No access provider "${id}"`);
  return found;
};

/** One `mint` per provider, for the policies that name it. */
export const mint = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const ids = [...new Set(policies.map((p) => p.provider))];
  const minted = await Promise.all(ids.map((id) => provider(ctx, id).mint(policies.filter((p) => p.provider === id), repo)));
  return minted.flat();
};

/** Each policy's problems for `repo`, from the provider it names. */
export const validate = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const problems = await Promise.all(
    policies.map((p) => {
      const found = ctx.providers.find((x) => x.id === p.provider);
      return found ? found.validate(p, repo) : [`No access provider "${p.provider}"`];
    }),
  );
  return problems.flat();
};

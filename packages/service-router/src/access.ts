import type { PolicyData } from "@achq/core";
import type { RouterContext } from "./context.ts";

const accessFor = (ctx: RouterContext, id: string) => {
  const found = ctx.access.find((p) => p.id === id);
  if (!found) throw new Error(`No access provider "${id}"`);
  return found;
};

/** One `mint` per access provider, for the policies that name it. */
export const mint = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const ids = [...new Set(policies.map((p) => p.access))];
  const minted = await Promise.all(ids.map((id) => accessFor(ctx, id).mint(policies.filter((p) => p.access === id), repo)));
  return minted.flat();
};

/** Each policy's problems for `repo`, from the access provider it names. */
export const validate = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const problems = await Promise.all(
    policies.map((p) => {
      const found = ctx.access.find((x) => x.id === p.access);
      return found ? found.validate(p, repo) : [`No access provider "${p.access}"`];
    }),
  );
  return problems.flat();
};

import type { PolicyData } from "@achq/core";
import type { RouterRepoConfig } from "@achq/core/protocol";
import type { RouterContext } from "../context.ts";

const noProvider = (id: string) => `No policy provider "${id}"`;

/** One `mint` per policy provider, for the policies that name it. */
export const mint = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const ids = [...new Set(policies.map((p) => p.provider))];
  const minted = await Promise.all(
    ids.map((id) => {
      const provider = ctx.policyProviders.find((p) => p.id === id);
      if (!provider) throw new Error(noProvider(id));
      return provider.mint(policies.filter((p) => p.provider === id), repo);
    }),
  );
  return minted.flat();
};

/** A provider nobody has is a problem too. */
export const validate = async (ctx: RouterContext, policies: PolicyData[], repo: string) => {
  const problems = await Promise.all(policies.map((p) => ctx.policyProviders.find((provider) => provider.id === p.provider)?.validate(p, repo) ?? [noProvider(p.provider)]));
  return problems.flat();
};

/** One client credential per (channel, source) the container's workspaces select threads from. */
export const mintClients = (ctx: RouterContext, config: RouterRepoConfig, container: string) => {
  const sources = new Map<string, { channel: string; source: string }>();
  for (const w of config.workspaces) {
    const { channel, source } = w.threads;
    if (w.container === container) sources.set(`${channel}\n${source}`, { channel, source });
  }
  return Promise.all(
    [...sources.values()].map(({ channel, source }) => {
      const provider = ctx.channelProviders.find((c) => c.id === channel);
      if (!provider) throw new Error(`No channel "${channel}"`);
      return provider.mintClient(source, config.repo);
    }),
  );
};

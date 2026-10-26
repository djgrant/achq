import { onePasswordVaultProvider } from "@achq/1password/vault";
import { claudeAgentProvider } from "@achq/claude/agent";
import { cloudflareContainerProvider } from "@achq/cloudflare/container";
import { type AgentProvider, type ChannelProvider, type CodeHostImplementation, type ContainerProviderImplementation, ENV, type Implementation, type PolicyProvider, type Stores, type VaultProvider } from "@achq/core";
import { githubChannelProvider } from "@achq/github/channel";
import { githubPolicyProvider } from "@achq/github/policy";
import { githubCodeHostProvider } from "@achq/github/code-host";
import { railwayContainerProvider } from "@achq/railway/container";
import type { Env } from "@achq/utils/env";

export const CHANNEL_PROVIDERS: Implementation<ChannelProvider>[] = [githubChannelProvider];
export const POLICY_PROVIDERS: Implementation<PolicyProvider>[] = [githubPolicyProvider];
/** Where every repo an infra serves lives, and achq's own code: an infra has one code host, so repos are told apart by `owner/name` alone. */
export const CODE_HOST: CodeHostImplementation = githubCodeHostProvider;
export const CONTAINER_PROVIDERS: ContainerProviderImplementation[] = [railwayContainerProvider, cloudflareContainerProvider];
export const AGENT_PROVIDERS: AgentProvider[] = [claudeAgentProvider];
/** Where `achq infra up` can keep secrets for reuse, as `achq.config.ts` names one. */
export const VAULT_PROVIDERS: Implementation<VaultProvider>[] = [onePasswordVaultProvider];

const lookup =
  <T extends { id: string }>(kind: string, all: T[]) =>
  (id: string): T => {
    const found = all.find((x) => x.id === id);
    if (!found) throw new Error(`achq doesn't know the ${kind} "${id}"; it knows ${all.map((x) => x.id).join(", ")}`);
    return found;
  };

export const channelProviderNamed = lookup("channel provider", CHANNEL_PROVIDERS);
export const policyProviderNamed = lookup("policy provider", POLICY_PROVIDERS);
export const containerProviderNamed = lookup("container provider", CONTAINER_PROVIDERS);
export const vaultProviderNamed = lookup("vault provider", VAULT_PROVIDERS);

/** The container provider a router or deployer runs on, as ENV.containerProvider names it, and the stores it keeps what outlives a restart in. */
export const serviceContainerProvider = (env: Env) => {
  const provider = containerProviderNamed(env.require(ENV.containerProvider));
  const stores: Stores = (collection) => provider.store(env.vars, collection);
  return { provider, stores };
};

/**
 * Every variable never given to an agent: the container secret, which proves a
 * container's identity to the router, so an agent holding it could mint every
 * credential the container has and post as the channel; the key, which only the
 * router and deployer have; and every implementation's `privateEnv`.
 */
export const privateEnv = () => [...new Set([ENV.containerSecret, ENV.key, ...[...CHANNEL_PROVIDERS, ...POLICY_PROVIDERS, CODE_HOST, ...CONTAINER_PROVIDERS].flatMap((i) => i.privateEnv)])];

/** The variables every agent container is given from the infra's env: each agent runtime's, e.g. its token. */
export const agentContainerEnv = () => AGENT_PROVIDERS.flatMap((a) => a.containerEnv);

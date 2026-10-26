import { onePasswordVaultProvider } from "@achq/1password/vault";
import { providers as claude } from "@achq/claude/providers";
import { providers as cloudflare } from "@achq/cloudflare/providers";
import { type Implementation, mergeProviders, onlyCodeHost, privateEnv as privateEnvOf, providerNamed, type Stores, type VaultProvider, ENV } from "@achq/core";
import { providers as github } from "@achq/github/providers";
import { providers as railway } from "@achq/railway/providers";
import type { Env } from "@achq/utils/env";

/** Every plugin achq ships, as one set of providers. */
export const PROVIDERS = mergeProviders([github, railway, cloudflare, claude]);

export const CHANNEL_PROVIDERS = PROVIDERS.channels;
export const POLICY_PROVIDERS = PROVIDERS.policies;
/** Where every repo an infra serves lives, and achq's own code: an infra has one code host, so repos are told apart by `owner/name` alone. */
export const CODE_HOST = onlyCodeHost(PROVIDERS);
export const CONTAINER_PROVIDERS = PROVIDERS.containers;
export const AGENT_PROVIDERS = PROVIDERS.agents;
/** Where `achq infra up` can keep secrets for reuse, as `achq.config.ts` names one. */
export const VAULT_PROVIDERS: Implementation<VaultProvider>[] = [onePasswordVaultProvider];

export const channelProviderNamed = (id: string) => providerNamed("channel provider", CHANNEL_PROVIDERS, id);
export const policyProviderNamed = (id: string) => providerNamed("policy provider", POLICY_PROVIDERS, id);
export const containerProviderNamed = (id: string) => providerNamed("container provider", CONTAINER_PROVIDERS, id);
export const vaultProviderNamed = (id: string) => providerNamed("vault provider", VAULT_PROVIDERS, id);

/** The container provider a router or deployer runs on, as ENV.containerProvider names it, and the stores it keeps what outlives a restart in. */
export const serviceContainerProvider = (env: Env) => {
  const provider = containerProviderNamed(env.require(ENV.containerProvider));
  const stores: Stores = (collection) => provider.store(env.vars, collection);
  return { provider, stores };
};

/** Every variable never given to an agent: core's `privateEnv` over every plugin's providers. */
export const privateEnv = () => privateEnvOf(PROVIDERS);

/** The variables every agent container is given from the infra's env: each agent runtime's, e.g. its token. */
export const agentContainerEnv = () => AGENT_PROVIDERS.flatMap((a) => a.containerEnv);

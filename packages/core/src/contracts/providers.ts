import { ENV } from "../wire/constants.ts";
import type { AgentProvider } from "./agent-provider.ts";
import type { ChannelProvider } from "./channel-provider.ts";
import type { CodeHostImplementation } from "./code-host-provider.ts";
import type { ContainerProviderImplementation } from "./container-provider.ts";
import type { Implementation } from "./implementation.ts";
import type { PolicyProvider } from "./policy-provider.ts";

/** What a plugin package provides, from its `./providers` export: each a list, so a plugin provides what it has. */
export type Providers = {
  channels?: Implementation<ChannelProvider>[];
  policies?: Implementation<PolicyProvider>[];
  containers?: ContainerProviderImplementation[];
  codeHosts?: CodeHostImplementation[];
  agents?: AgentProvider[];
};

/** Several plugins' providers as one. */
export const mergeProviders = (all: Providers[]): Required<Providers> => ({
  channels: all.flatMap((p) => p.channels ?? []),
  policies: all.flatMap((p) => p.policies ?? []),
  containers: all.flatMap((p) => p.containers ?? []),
  codeHosts: all.flatMap((p) => p.codeHosts ?? []),
  agents: all.flatMap((p) => p.agents ?? []),
});

/** The one of `all` whose id is `id`, or an error naming what's there, e.g. `achq doesn't know the channel provider "slack"; it knows github`. */
export const providerNamed = <T extends { id: string }>(kind: string, all: T[], id: string): T => {
  const found = all.find((x) => x.id === id);
  if (!found) throw new Error(`achq doesn't know the ${kind} "${id}"; it knows ${all.map((x) => x.id).join(", ") || "none"}`);
  return found;
};

/** The one code host: an infra has exactly one. */
export const onlyCodeHost = (providers: Providers): CodeHostImplementation => {
  const [codeHost, ...rest] = providers.codeHosts ?? [];
  if (!codeHost || rest.length) throw new Error(`An infra has one code host; the plugins loaded provide ${providers.codeHosts?.length ?? 0}`);
  return codeHost;
};

/**
 * Every variable never given to an agent: the container secret, which proves a
 * container's identity to the router, so an agent holding it could mint every
 * credential the container has and post as the channel; the key, which only the
 * router and deployer have; and every implementation's `privateEnv`.
 */
export const privateEnv = (providers: Providers) => {
  const implementations = [...(providers.channels ?? []), ...(providers.policies ?? []), ...(providers.codeHosts ?? []), ...(providers.containers ?? [])];
  return [...new Set([ENV.containerSecret, ENV.key, ...implementations.flatMap((i) => i.privateEnv)])];
};

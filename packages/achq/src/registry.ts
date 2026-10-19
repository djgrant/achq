// The implementations achq is built with, one list per contract. The CLI,
// router, deployer and container only use core's contracts, and find the
// implementation here by id.
import { claudeAgent } from "@achq/claude/agents";
import type { AgentProvider, ChannelProvider, ContainerProvider, ContainerShell, Implementation, CodeHostProvider, PolicyProvider } from "@achq/core";
import { githubChannelProvider } from "@achq/github/channel";
import { githubPolicyProvider } from "@achq/github/policy";
import { githubCodeHostProvider } from "@achq/github/code-host";
import { railwayContainerProvider } from "@achq/railway/container";
import * as github from "./github-infra.ts";
import * as achq from "./index.ts";
import * as railway from "./railway.ts";

export const CHANNEL_PROVIDERS: Implementation<ChannelProvider>[] = [githubChannelProvider];
export const POLICY_PROVIDERS: Implementation<PolicyProvider>[] = [githubPolicyProvider];
export const CODE_HOST_PROVIDERS: Implementation<CodeHostProvider>[] = [githubCodeHostProvider];
export const CONTAINER_PROVIDERS: (Implementation<ContainerProvider> & { shell: ContainerShell })[] = [railwayContainerProvider];
export const AGENT_PROVIDERS: AgentProvider[] = [claudeAgent];

const lookup =
  <T extends { id: string }>(kind: string, all: T[]) =>
  (id: string): T => {
    const found = all.find((x) => x.id === id);
    if (!found) throw new Error(`achq doesn't know the ${kind} "${id}"; it knows ${all.map((x) => x.id).join(", ")}`);
    return found;
  };

export const channelProviderNamed = lookup("channel provider", CHANNEL_PROVIDERS);
export const policyProviderNamed = lookup("policy provider", POLICY_PROVIDERS);
export const codeHostProviderNamed = lookup("code host provider", CODE_HOST_PROVIDERS);
export const containerProviderNamed = lookup("container provider", CONTAINER_PROVIDERS);
/** For a location's `containerProvider`, which may name a provider this build doesn't have. */
export const findContainerProvider = (id: string | undefined) => CONTAINER_PROVIDERS.find((h) => h.id === id);

/** Every variable only the router and deployer have: the union of every implementation's privateEnv. */
export const privateEnv = () => [...new Set([...CHANNEL_PROVIDERS, ...POLICY_PROVIDERS, ...CODE_HOST_PROVIDERS, ...CONTAINER_PROVIDERS].flatMap((i) => i.privateEnv))];

/** The variables every container needs, for every agent runtime. */
export const agentEnv = () => AGENT_PROVIDERS.flatMap((a) => a.containerEnv);

/** The bare imports a repo's `.achq/` may use. */
export const CONFIG_MODULES = ["achq", "achq/github"];
/** What the infra file's imports resolve to. */
export const INFRA_MODULES: Record<string, object> = { achq, "achq/github": github, "achq/railway": railway };

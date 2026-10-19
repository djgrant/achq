// The implementations achq is built with, one list per contract. The CLI,
// router, deployer and container only use core's contracts, and find the
// implementation here by id.
import { claudeAgent } from "@achq/claude/agents";
import type { AgentProvider, Channel, ContainerHost, ContainerShell, Implementation, InstallationProvider, CodeHost, PolicyProvider } from "@achq/core";
import { githubChannel } from "@achq/github/channels";
import { githubInstallationProvider } from "@achq/github/installation";
import { githubPolicyProvider } from "@achq/github/policy";
import { githubCodeHost } from "@achq/github/code-hosts";
import { railwayContainerHost } from "@achq/railway/container-hosts";
import * as github from "./github-infra.ts";
import * as achq from "./index.ts";
import * as railway from "./railway.ts";

export const CHANNELS: Implementation<Channel>[] = [githubChannel];
export const INSTALLATION_PROVIDERS: Implementation<InstallationProvider>[] = [githubInstallationProvider];
export const POLICY_PROVIDERS: Implementation<PolicyProvider>[] = [githubPolicyProvider];
export const CODE_HOSTS: Implementation<CodeHost>[] = [githubCodeHost];
export const CONTAINER_HOSTS: (Implementation<ContainerHost> & { shell: ContainerShell })[] = [railwayContainerHost];
export const AGENTS: AgentProvider[] = [claudeAgent];

const lookup =
  <T extends { id: string }>(kind: string, all: T[]) =>
  (id: string): T => {
    const found = all.find((x) => x.id === id);
    if (!found) throw new Error(`achq doesn't know the ${kind} "${id}"; it knows ${all.map((x) => x.id).join(", ")}`);
    return found;
  };

export const channelNamed = lookup("channel", CHANNELS);
export const installationProviderNamed = lookup("installation provider", INSTALLATION_PROVIDERS);
export const policyProviderNamed = lookup("policy provider", POLICY_PROVIDERS);
export const codeHostNamed = lookup("code host", CODE_HOSTS);
export const containerHostNamed = lookup("container host", CONTAINER_HOSTS);
/** For a location's `containerHost`, which may name a host this build doesn't have. */
export const findContainerHost = (id: string | undefined) => CONTAINER_HOSTS.find((h) => h.id === id);

/** Every variable only the router and deployer have: the union of every implementation's privateEnv. */
export const privateEnv = () => [...new Set([...CHANNELS, ...INSTALLATION_PROVIDERS, ...POLICY_PROVIDERS, ...CODE_HOSTS, ...CONTAINER_HOSTS].flatMap((i) => i.privateEnv))];

/** The variables every container needs, for every agent runtime. */
export const agentEnv = () => AGENTS.flatMap((a) => a.containerEnv);

/** The bare imports a repo's `.achq/` may use. */
export const CONFIG_MODULES = ["achq", "achq/github"];
/** What the infra file's imports resolve to. */
export const INFRA_MODULES: Record<string, object> = { achq, "achq/github": github, "achq/railway": railway };
